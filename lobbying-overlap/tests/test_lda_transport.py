"""Tests for LDA transport-level failure handling.

The production failure this guards against: lda.senate.gov started 301ing
to lda.gov and then 302ing to the homepage. With redirects followed, the
client got a 200 carrying an HTML page, sailed past every status check,
and died in `.json()` with `JSONDecodeError: Expecting value: line 2
column 1` — an error naming nothing that was actually wrong.

The contract: a moved endpoint, a WAF interstitial, or any non-JSON body
must raise LDAError naming the real cause, never a bare decode error.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from src.sources.lda import (
    BASE_URL,
    USER_AGENT,
    LDAError,
    _auth_headers,
    _ensure_json,
    _get_page,
    _RateLimiter,
)


def run(coro):  # small helper — pytest-asyncio not in deps
    return asyncio.new_event_loop().run_until_complete(coro)


def _response(status: int, *, text: str, content_type: str) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        headers={"Content-Type": content_type},
        text=text,
        request=httpx.Request("GET", BASE_URL),
    )


# The exact body that crashed the actor: note the leading newline, which is
# what put the decode error at "line 2 column 1".
_HTML_BODY = '\n<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>Home | LDA.gov</title>'


class TestEnsureJson:
    def test_html_body_with_200_raises_lda_error(self) -> None:
        response = _response(200, text=_HTML_BODY, content_type="text/html; charset=utf-8")
        with pytest.raises(LDAError) as excinfo:
            _ensure_json(response)
        message = str(excinfo.value)
        assert "non-JSON" in message
        assert "may have moved" in message

    def test_valid_json_passes_through(self) -> None:
        response = _response(
            200, text='{"count": 3, "results": []}', content_type="application/json"
        )
        assert _ensure_json(response) == {"count": 3, "results": []}

    def test_malformed_json_body_raises_lda_error(self) -> None:
        response = _response(200, text="{not json", content_type="application/json")
        with pytest.raises(LDAError, match="undecodable JSON"):
            _ensure_json(response)


class TestGetPageTransport:
    def _fetch(self, handler) -> dict:
        async def scenario() -> dict:
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(
                transport=transport, headers=_auth_headers(None)
            ) as client:
                return await _get_page(
                    client,
                    {"page": 1},
                    asyncio.Semaphore(1),
                    _RateLimiter(rate_per_sec=1000),
                )

        return run(scenario())

    def test_redirect_is_reported_as_moved_endpoint(self) -> None:
        """A 3xx must name the move, not fall through to a decode error."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(301, headers={"Location": "https://lda.gov"})

        with pytest.raises(LDAError) as excinfo:
            self._fetch(handler)
        assert "redirected" in str(excinfo.value)
        assert "likely moved" in str(excinfo.value)

    def test_success_returns_decoded_payload(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"count": 1, "results": [{"a": 1}]})

        assert self._fetch(handler) == {"count": 1, "results": [{"a": 1}]}


class TestUserAgent:
    def test_user_agent_is_sent(self) -> None:
        """lda.gov's WAF 403s known scripting-client UAs, so we must send ours."""
        assert _auth_headers(None)["User-Agent"] == USER_AGENT

    def test_user_agent_avoids_blocked_client_tokens(self) -> None:
        lowered = USER_AGENT.lower()
        assert not any(t in lowered for t in ("python-httpx", "requests/", "curl/"))

    def test_user_agent_identifies_the_actor(self) -> None:
        assert "actor" in USER_AGENT.lower()
