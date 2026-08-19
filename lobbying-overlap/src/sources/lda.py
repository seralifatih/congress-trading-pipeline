"""Senate LDA REST API source.

Fetches quarterly LD-2 filings from lda.gov and maps raw responses
to the `LobbyingFiling` model. This is the primary lobbying source
(House Clerk XML is fill-in only — see CLAUDE.md).

Design constraints enforced here:
- Bounded concurrency via an asyncio.Semaphore.
- Every request has an explicit timeout.
- Retry with exponential backoff; 429 honours `Retry-After` when present.
- API key resolved via `resolve_api_key()` — actor input, then the
  `LDA_API_KEY` env var, else anonymous — sent as `Authorization: Token
  <key>`. The key value itself is never logged, only which mode won.

Standalone use — fetch one quarter to JSON for manual inspection:

    LDA_API_KEY=xxx python -m src.sources.lda 2026-Q1 --out q.json

Runs without a key too (LDA allows anonymous access at a lower rate limit),
but a key is strongly recommended to avoid throttling.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import re
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

# Support both `python -m src.sources.lda` (package) and direct execution.
if __package__:
    from ..models import LobbyingFiling
else:  # pragma: no cover - only when run as a loose script
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models import LobbyingFiling  # type: ignore[no-redefine]

logger = logging.getLogger(__name__)

# The API moved off lda.senate.gov in 2026: that host now 301s to lda.gov
# and 302s to the homepage, discarding the API path. Because the redirect
# lands on a 200 HTML page, pointing at the old host fails as a JSON decode
# error rather than an HTTP error — hence `_ensure_json` below.
BASE_URL = "https://lda.gov/api/v1/filings/"
API_KEY_ENV = "LDA_API_KEY"

# lda.gov sits behind Akamai, which 403s known scripting-client user agents
# (python-httpx, requests, curl) with an HTML "Access Denied" page. The
# `Mozilla/5.0 (compatible; ...)` form is the standard way for a non-browser
# client to get served while still identifying itself honestly — we do not
# claim to be a browser.
USER_AGENT = "Mozilla/5.0 (compatible; congress-lobbying-overlap-actor/1.0)"

# Our quarter label (2026-Q1) -> LDA filing_period query value.
_QUARTER_TO_PERIOD: dict[str, str] = {
    "Q1": "first_quarter",
    "Q2": "second_quarter",
    "Q3": "third_quarter",
    "Q4": "fourth_quarter",
}
_QUARTER_RE = re.compile(r"^(?P<year>\d{4})-(?P<q>Q[1-4])$")

DEFAULT_TIMEOUT = 30.0  # seconds; LDA can be slow on large pages
DEFAULT_PAGE_SIZE = 100  # LDA max is 100
DEFAULT_MAX_CONCURRENCY = 5
MAX_RETRIES = 6
BACKOFF_BASE = 5.0  # seconds
BACKOFF_CAP = 120.0  # seconds

# Global request pacing. The LDA quota is per key (registered ~120/min,
# anonymous ~15/min) and shared by ALL page tasks — per-task backoff alone
# cannot respect a shared quota: tasks burn it in a burst, then all 429
# together, back off together, and slam back together. These rates keep a
# safety margin under the documented limits.
RATE_WITH_KEY = 1.5  # req/sec ≈ 90/min
RATE_ANONYMOUS = 0.2  # req/sec ≈ 12/min


class _RateLimiter:
    """Paces request starts globally and shares 429 cooldowns.

    `acquire()` hands out evenly spaced start slots; `cooldown()` pushes
    the next slot past a server-imposed wait so every task — retrying or
    fresh — respects the same pause instead of competing for it.
    """

    def __init__(self, rate_per_sec: float) -> None:
        self._interval = 1.0 / rate_per_sec
        self._next_slot = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = asyncio.get_running_loop().time()
            wait = self._next_slot - now
            self._next_slot = max(now, self._next_slot) + self._interval
        if wait > 0:
            await asyncio.sleep(wait)

    def cooldown(self, seconds: float) -> None:
        target = asyncio.get_running_loop().time() + seconds
        if target > self._next_slot:
            self._next_slot = target


class LDAError(RuntimeError):
    """Non-retryable failure talking to the LDA API."""


class LDAThrottled(RuntimeError):
    """A page gave up after exhausting retries against a 429.

    Not a hard failure — the caller should finish the run cleanly with
    whatever filings were already fetched, and flag it in RUN_SUMMARY.
    """


def _parse_quarter(quarter: str) -> tuple[int, str]:
    """'2026-Q1' -> (2026, 'first_quarter'). Raise on malformed input."""
    match = _QUARTER_RE.match(quarter)
    if not match:
        raise LDAError(f"malformed quarter {quarter!r}; expected e.g. '2026-Q1'")
    year = int(match["year"])
    return year, _QUARTER_TO_PERIOD[match["q"]]


def resolve_api_key(input_key: str | None) -> tuple[str | None, str]:
    """Resolve the LDA key: actor input wins, then env var, else anonymous.

    Returns (key, mode) where mode is one of "input", "env", "anonymous".
    Never logs the key itself — callers should log only `mode`.
    """
    if input_key:
        return str(input_key), "input"
    env_key = os.environ.get(API_KEY_ENV)
    if env_key:
        return env_key, "env"
    return None, "anonymous"


def _auth_headers(key: str | None) -> dict[str, str]:
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if key:
        headers["Authorization"] = f"Token {key}"
    return headers


def _backoff_delay(attempt: int, retry_after: float | None) -> float:
    """Exponential backoff with full jitter; honour Retry-After if given."""
    if retry_after is not None:
        return retry_after
    raw = min(BACKOFF_CAP, BACKOFF_BASE * (2**attempt))
    return random.uniform(0, raw)


def _retry_after_seconds(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return float(value)  # LDA sends seconds as an integer string
    except ValueError:
        logger.debug("Unparseable Retry-After header: %r", value)
        return None


def _ensure_json(response: httpx.Response) -> dict:
    """Decode a 2xx body as JSON, or raise LDAError naming the real cause.

    A redirect to an HTML page (host move, captive portal, WAF interstitial)
    arrives as a 200 whose body is HTML, so the status checks above pass and
    `.json()` blows up with an opaque JSONDecodeError. Fail loudly instead,
    reporting where we actually landed.
    """
    content_type = response.headers.get("Content-Type", "")
    if "json" not in content_type.lower():
        raise LDAError(
            f"LDA returned {response.status_code} with non-JSON Content-Type "
            f"{content_type!r} from {response.url} — the API endpoint may have "
            f"moved or the request was intercepted. Body: {response.text[:200]!r}"
        )
    try:
        return response.json()
    except ValueError as exc:
        raise LDAError(
            f"LDA returned undecodable JSON from {response.url}: {exc}. "
            f"Body: {response.text[:200]!r}"
        ) from exc


async def _get_page(
    client: httpx.AsyncClient,
    params: dict[str, str | int],
    semaphore: asyncio.Semaphore,
    limiter: _RateLimiter,
) -> dict:
    """GET one page with global pacing, bounded concurrency, and retry.

    Retries on 429 and 5xx and on transport/timeout errors. A 429 puts
    the WHOLE pipeline on cooldown via the shared limiter. Raises
    `LDAThrottled` after exhausting retries against a 429 (the caller may
    treat this as a soft stop), `LDAError` on other 4xx and on exhausted
    5xx/transport retries.
    """
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        await limiter.acquire()
        try:
            async with semaphore:
                response = await client.get(BASE_URL, params=params)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_exc = exc
            delay = _backoff_delay(attempt, None)
            logger.warning(
                "LDA request error (%s), attempt %d/%d, retrying in %.1fs",
                type(exc).__name__,
                attempt + 1,
                MAX_RETRIES + 1,
                delay,
            )
            await asyncio.sleep(delay)
            continue

        if response.status_code == 429 or response.status_code >= 500:
            if attempt == MAX_RETRIES:
                if response.status_code == 429:
                    raise LDAThrottled(
                        f"LDA API returned 429 on page {params.get('page')} "
                        f"after {MAX_RETRIES + 1} attempts"
                    )
                raise LDAError(
                    f"LDA API returned {response.status_code} after "
                    f"{MAX_RETRIES + 1} attempts"
                )
            delay = _backoff_delay(attempt, _retry_after_seconds(response))
            if response.status_code == 429:
                # Shared quota exhausted — pause everyone, not just this task.
                limiter.cooldown(delay)
            logger.warning(
                "LDA %d on page %s, attempt %d/%d, backing off %.1fs",
                response.status_code,
                params.get("page"),
                attempt + 1,
                MAX_RETRIES + 1,
                delay,
            )
            await asyncio.sleep(delay + random.uniform(0, 1))
            continue

        if response.status_code >= 400:
            raise LDAError(
                f"LDA API {response.status_code} for params {params}: "
                f"{response.text[:300]}"
            )

        if response.is_redirect:
            raise LDAError(
                f"LDA API redirected ({response.status_code}) from {BASE_URL} "
                f"to {response.headers.get('Location')!r} — the endpoint has "
                f"likely moved; update BASE_URL."
            )

        return _ensure_json(response)

    # Loop only exits here after transport/timeout retries are exhausted.
    raise LDAError(f"LDA request failed after retries: {last_exc}")


async def iter_raw_filings(
    quarter: str,
    *,
    page_size: int = DEFAULT_PAGE_SIZE,
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
    timeout: float = DEFAULT_TIMEOUT,
    max_pages: int | None = None,
    api_key: str | None = None,
) -> AsyncIterator[dict]:
    """Yield raw filing dicts for a quarter, paging through all results.

    Page 1 is fetched first to learn `count`; remaining pages are fetched
    with bounded concurrency. `max_pages` caps the number of pages fetched
    (a full quarter is tens of thousands of filings) — used mainly for the
    standalone-inspection CLI. None means fetch everything.

    `api_key` should already be resolved by the caller via
    `resolve_api_key()` (input > env > anonymous); this function only
    ever sees the winning key, never decides between sources itself.
    Falls back to the env var directly for standalone/CLI use.
    """
    year, period = _parse_quarter(quarter)
    semaphore = asyncio.Semaphore(max_concurrency)
    base_params: dict[str, str | int] = {
        "filing_year": year,
        "filing_period": period,
        "page_size": page_size,
    }

    key = api_key if api_key is not None else os.environ.get(API_KEY_ENV)
    has_key = key is not None
    limiter = _RateLimiter(RATE_WITH_KEY if has_key else RATE_ANONYMOUS)

    limits = httpx.Limits(max_connections=max_concurrency)
    async with httpx.AsyncClient(
        headers=_auth_headers(key),
        timeout=httpx.Timeout(timeout),
        limits=limits,
        # Deliberately NOT following redirects: this is a fixed API endpoint
        # that should never legitimately redirect. Following them is how the
        # 2026 lda.senate.gov -> lda.gov move surfaced as an opaque JSON
        # decode error instead of an obvious failure. A 3xx now raises.
        follow_redirects=False,
    ) as client:
        logger.info(
            "Fetching LDA filings for %s (year=%d, %s) at %.1f req/s",
            quarter, year, period,
            RATE_WITH_KEY if has_key else RATE_ANONYMOUS,
        )
        try:
            first = await _get_page(
                client, {**base_params, "page": 1}, semaphore, limiter
            )
        except LDAThrottled:
            logger.warning(
                "LDA %s: throttled fetching page 1; stopping this quarter "
                "with zero filings.", quarter,
            )
            return

        count = int(first.get("count", 0))
        results = first.get("results", [])
        for item in results:
            yield item

        if not results or count <= len(results):
            logger.info("LDA %s: %d filings, single page", quarter, count)
            return

        total_pages = -(-count // page_size)  # ceil
        if max_pages is not None:
            total_pages = min(total_pages, max_pages)
            logger.info(
                "LDA %s: %d filings, capping at %d pages", quarter, count, total_pages
            )
        else:
            logger.info(
                "LDA %s: %d filings across %d pages", quarter, count, total_pages
            )
        if total_pages > 20 and not has_key:
            logger.warning(
                "Fetching %d pages WITHOUT an LDA API key — anonymous access "
                "is heavily rate-limited and this will very likely fail with "
                "429s. Register a free key at lda.gov and set the "
                "lda_api_key input (or %s).",
                total_pages, API_KEY_ENV,
            )

        async def fetch(page: int) -> list[dict]:
            data = await _get_page(
                client, {**base_params, "page": page}, semaphore, limiter
            )
            return data.get("results", [])

        tasks = [
            asyncio.create_task(fetch(page))
            for page in range(2, total_pages + 1)
        ]
        throttled = False
        try:
            for coro in asyncio.as_completed(tasks):
                try:
                    items = await coro
                except LDAThrottled:
                    logger.warning(
                        "LDA %s: throttled after exhausting retries on a "
                        "page; stopping this quarter with filings gathered "
                        "so far.", quarter,
                    )
                    throttled = True
                    break
                for item in items:
                    yield item
        finally:
            # On any early exit (throttled, page error after retries,
            # cancelled consumer) cancel the remaining page tasks BEFORE
            # the client context closes — otherwise they fire against a
            # closed client and flood the log with unretrieved-task
            # exceptions.
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        if throttled:
            raise LDAThrottled(f"LDA {quarter}: throttled, partial results only")


def _parse_amount(raw: object) -> float | None:
    """LDA income/expenses come as decimal strings or null."""
    if raw in (None, ""):
        return None
    try:
        return float(str(raw))
    except ValueError:
        logger.debug("Unparseable amount: %r", raw)
        return None


def map_filing(raw: dict) -> LobbyingFiling | None:
    """Map one raw LDA filing dict to a `LobbyingFiling`.

    Returns None (and logs) for filings with no reportable issue codes —
    LD-2s can carry zero lobbying activities and are not useful for the join.
    `amount_reported` prefers income (lobbying firms) then expenses
    (self-filers); either may be null.
    """
    registrant = raw.get("registrant") or {}
    client = raw.get("client") or {}
    activities = raw.get("lobbying_activities") or []

    issue_codes = sorted(
        {
            a["general_issue_code"]
            for a in activities
            if a.get("general_issue_code")
        }
    )
    if not issue_codes:
        logger.debug(
            "Skipping filing %s: no issue codes", raw.get("filing_uuid")
        )
        return None

    income = _parse_amount(raw.get("income"))
    expenses = _parse_amount(raw.get("expenses"))
    amount_reported = income if income is not None else expenses

    try:
        return LobbyingFiling(
            lda_filing_uuid=raw["filing_uuid"],
            lda_url=raw["url"],
            registrant=registrant.get("name") or "<unknown registrant>",
            client=client.get("name") or "<unknown client>",
            issue_codes=issue_codes,
            amount_reported=amount_reported,
        )
    except KeyError as exc:
        raise LDAError(f"LDA filing missing required field {exc}") from exc


@dataclass
class QuarterResult:
    """Outcome of fetching one quarter. `throttled=True` means retries
    were exhausted against a 429 partway through — `filings` still holds
    whatever was gathered before that point, and the caller should
    surface `lda_throttled: true` in RUN_SUMMARY rather than fail the run.
    """

    filings: list[LobbyingFiling]
    throttled: bool = False


async def fetch_quarter(
    quarter: str,
    *,
    page_size: int = DEFAULT_PAGE_SIZE,
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
    timeout: float = DEFAULT_TIMEOUT,
    max_pages: int | None = None,
    api_key: str | None = None,
) -> QuarterResult:
    """Fetch and map every filing for a quarter into `LobbyingFiling`s."""
    filings: list[LobbyingFiling] = []
    skipped = 0
    throttled = False
    try:
        async for raw in iter_raw_filings(
            quarter,
            page_size=page_size,
            max_concurrency=max_concurrency,
            timeout=timeout,
            max_pages=max_pages,
            api_key=api_key,
        ):
            mapped = map_filing(raw)
            if mapped is None:
                skipped += 1
                continue
            filings.append(mapped)
    except LDAThrottled:
        throttled = True
    logger.info(
        "LDA %s: mapped %d filings, skipped %d (no issue codes)%s",
        quarter,
        len(filings),
        skipped,
        ", THROTTLED (partial)" if throttled else "",
    )
    return QuarterResult(filings=filings, throttled=throttled)


# --------------------------------------------------------------------------
# Standalone CLI — fetch one quarter to JSON for manual inspection.
# --------------------------------------------------------------------------
async def _main_async(args: argparse.Namespace) -> int:
    result = await fetch_quarter(
        args.quarter,
        page_size=args.page_size,
        max_concurrency=args.concurrency,
        timeout=args.timeout,
        max_pages=args.max_pages,
    )
    payload = [f.model_dump(mode="json") for f in result.filings]
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        print(f"Wrote {len(payload)} filings to {args.out}", file=sys.stderr)
    else:
        json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
        print(file=sys.stdout)
    if result.throttled:
        print("warning: throttled, results are partial", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch one quarter of LDA filings.")
    parser.add_argument("quarter", help="Quarter to fetch, e.g. 2026-Q1")
    parser.add_argument("--out", help="Write JSON here instead of stdout")
    parser.add_argument(
        "--page-size", type=int, default=DEFAULT_PAGE_SIZE, dest="page_size"
    )
    parser.add_argument(
        "--concurrency", type=int, default=DEFAULT_MAX_CONCURRENCY
    )
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument(
        "--max-pages",
        type=int,
        default=None,
        dest="max_pages",
        help="Cap pages fetched (for inspection; a full quarter is huge)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="DEBUG logging"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        return asyncio.run(_main_async(args))
    except LDAError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
