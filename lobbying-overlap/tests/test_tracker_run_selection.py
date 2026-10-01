"""Tracker-run selection: the overlap actor must not silently consume a
partial (filtered / truncated / debug / wrong-window) tracker dataset."""

from __future__ import annotations

import asyncio
from datetime import date

import pytest

from src.sources import ptr
from src.sources.ptr import PTRSourceError, _quarter_bounds, assess_run

FULL = {
    "truncated": False, "reason": None, "rowsEmitted": 900, "rowsNotEmitted": 0,
    "windowFrom": "2026-03-01", "windowTo": "2026-09-30",
    "skippedByMemberCount": 0, "skippedByTransactionDateCount": 0,
    "filteredByTickerCount": 0, "filteredByTransactionDateCount": 0,
    "placeholdersWithheld": 0, "placeholdersExcludedCount": 0,
}
Q = ["2026-Q2"]


def test_quarter_bounds() -> None:
    assert _quarter_bounds("2026-Q2") == (date(2026, 4, 1), date(2026, 6, 30))
    assert _quarter_bounds("2026-Q4") == (date(2026, 10, 1), date(2026, 12, 31))
    assert _quarter_bounds("2026-Q1") == (date(2026, 1, 1), date(2026, 3, 31))


class TestAssessRun:
    def test_full_run_is_suitable(self) -> None:
        v = assess_run(FULL, {}, Q)
        assert v.reasons == [] and v.warnings == []

    def test_missing_summary_rejected(self) -> None:
        assert assess_run(None, {}, Q).reasons

    def test_truncated_rejected(self) -> None:
        v = assess_run({**FULL, "truncated": True, "rowsNotEmitted": 40}, {}, Q)
        assert any("truncated" in r for r in v.reasons)

    @pytest.mark.parametrize(
        "key",
        ["skippedByMemberCount", "filteredByTickerCount",
         "skippedByTransactionDateCount", "filteredByTransactionDateCount",
         "placeholdersWithheld"],
    )
    def test_filter_counters_rejected(self, key: str) -> None:
        v = assess_run({**FULL, key: 3}, {}, Q)
        assert any(key in r for r in v.reasons)

    def test_members_filter_in_input_rejected_even_if_nobody_skipped(self) -> None:
        v = assess_run(FULL, {"members": ["Tommy Tuberville"]}, Q)
        assert any("members" in r for r in v.reasons)

    def test_debug_limit_rejected(self) -> None:
        assert assess_run(FULL, {"debugPtrLimit": 5}, Q).reasons

    def test_empty_filter_inputs_ok(self) -> None:
        assert assess_run(FULL, {"members": [], "tickers": [], "debugPtrLimit": 0}, Q).reasons == []

    def test_window_not_covering_quarter_rejected(self) -> None:
        v = assess_run({**FULL, "windowFrom": "2026-05-01"}, {}, Q)
        assert any("does not cover" in r for r in v.reasons)
        v = assess_run({**FULL, "windowTo": "2026-06-15"}, {}, Q)
        assert any("does not cover" in r for r in v.reasons)

    def test_window_without_late_filing_grace_warns_not_rejects(self) -> None:
        v = assess_run({**FULL, "windowTo": "2026-07-10"}, {}, Q)
        assert v.reasons == [] and v.warnings

    def test_missing_window_rejected(self) -> None:
        s = {k: v for k, v in FULL.items() if k != "windowFrom"}
        assert assess_run(s, {}, Q).reasons


# --- walk-back with the Apify API stubbed --------------------------------
def _install_api(monkeypatch: pytest.MonkeyPatch, runs: list[dict], kv: dict, items: dict):
    class Resp:
        def __init__(self, payload: object) -> None:
            self._p = payload

        def json(self) -> object:
            return self._p

    async def fake_get(client, url: str, params: dict):
        if url.endswith("/runs"):
            return Resp({"data": {"items": runs}})
        if "/datasets/" in url:
            return Resp(items[url.split("/datasets/")[1].split("/")[0]])
        raise AssertionError(url)

    async def fake_optional(client, url: str, params: dict):
        store, key = url.split("/key-value-stores/")[1].split("/records/")
        value = kv.get((store, key))
        return None if value is None else Resp(value)

    monkeypatch.setattr(ptr, "_api_get", fake_get)
    monkeypatch.setattr(ptr, "_api_get_optional", fake_optional)


def _run(rid: str) -> dict:
    return {"id": rid, "defaultDatasetId": f"ds-{rid}",
            "defaultKeyValueStoreId": f"kv-{rid}", "finishedAt": "2026-10-01T00:00:00Z"}


def test_walks_back_past_filtered_run_and_records_provenance(monkeypatch) -> None:
    runs = [_run("new-filtered"), _run("good")]
    kv = {
        ("kv-new-filtered", "RUN_SUMMARY"): {**FULL, "skippedByMemberCount": 80},
        ("kv-new-filtered", "INPUT"): {"members": ["Tommy Tuberville"]},
        ("kv-good", "RUN_SUMMARY"): FULL,
        ("kv-good", "INPUT"): {},
    }
    _install_api(monkeypatch, runs, kv, {"ds-good": [{"id": "r1"}]})
    items, run = asyncio.run(ptr.fetch_tracker_items("senate", Q, token="t"))
    assert items == [{"id": "r1"}]
    assert run.run_id == "good"
    assert run.run_summary["rowsEmitted"] == 900
    assert [rid for rid, _ in run.rejected] == ["new-filtered"]


def test_fails_loudly_when_no_run_is_suitable(monkeypatch) -> None:
    runs = [_run("a"), _run("b")]
    kv = {
        ("kv-a", "RUN_SUMMARY"): {**FULL, "truncated": True},
        ("kv-b", "RUN_SUMMARY"): None,  # pre-1.5 run: no summary
    }
    _install_api(monkeypatch, runs, kv, {})
    with pytest.raises(PTRSourceError, match="no suitable tracker run"):
        asyncio.run(ptr.fetch_tracker_items("house", Q, token="t"))


def test_no_runs_at_all_fails(monkeypatch) -> None:
    _install_api(monkeypatch, [], {}, {})
    with pytest.raises(PTRSourceError):
        asyncio.run(ptr.fetch_tracker_items("house", Q, token="t"))
