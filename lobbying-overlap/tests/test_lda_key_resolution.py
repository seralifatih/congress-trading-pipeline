"""Tests for LDA API key resolution order: input > env > anonymous."""

from __future__ import annotations

from src.sources.lda import API_KEY_ENV, resolve_api_key


class TestResolveApiKey:
    def test_input_key_wins(self, monkeypatch) -> None:
        monkeypatch.setenv(API_KEY_ENV, "env-key")
        key, mode = resolve_api_key("input-key")
        assert (key, mode) == ("input-key", "input")

    def test_falls_back_to_env_when_input_empty(self, monkeypatch) -> None:
        monkeypatch.setenv(API_KEY_ENV, "env-key")
        key, mode = resolve_api_key(None)
        assert (key, mode) == ("env-key", "env")

    def test_anonymous_when_both_empty(self, monkeypatch) -> None:
        monkeypatch.delenv(API_KEY_ENV, raising=False)
        key, mode = resolve_api_key(None)
        assert (key, mode) == (None, "anonymous")

    def test_empty_string_input_treated_as_absent(self, monkeypatch) -> None:
        monkeypatch.setenv(API_KEY_ENV, "env-key")
        key, mode = resolve_api_key("")
        assert (key, mode) == ("env-key", "env")
