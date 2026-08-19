"""Actor entry point — full pipeline.

    input → parallel fetch (legislators / LDA quarters / PTR datasets)
          → adapt trades → join (pure) → dataset + RUN_SUMMARY

Zero-overlap runs still write a RUN_SUMMARY: a quarter where nothing
overlapped is itself information (see pricing rationale in CLAUDE.md).
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timezone

from apify import Actor

from .models import OverlapType, RunSummary, SourceFreshness, UnmappedItem
from .crosswalk import Crosswalk
from .overlap import MemberTrade, QuarterFiling, build_overlaps, quarter_of
from .sources import lda, ptr
from .sources.legislators import load_members

VALID_CHAMBERS = ("house", "senate")

# Hard cap on outbound concurrency regardless of what the caller requests.
# The shared LDA key's quota is per-key, not per-run — one user with a high
# max_concurrency input could starve every other run using the shared key.
MAX_ALLOWED_CONCURRENCY = 10


def previous_quarter(today: date) -> str:
    """Most recent *completed* calendar quarter — the default scan window
    (this data is quarterly by law; the current quarter is never complete)."""
    quarter = (today.month - 1) // 3 + 1
    if quarter == 1:
        return f"{today.year - 1}-Q4"
    return f"{today.year}-Q{quarter - 1}"


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}

        quarters: list[str] = actor_input.get("quarters") or [
            previous_quarter(date.today())
        ]
        chambers: list[str] = [
            c for c in actor_input.get("chambers", list(VALID_CHAMBERS))
            if c in VALID_CHAMBERS
        ]
        overlap_types: set[str] = set(
            actor_input.get(
                "overlap_types", ["committee_match", "sector_match_only"]
            )
        )
        max_concurrency: int = int(actor_input.get("max_concurrency", 5))
        if max_concurrency > MAX_ALLOWED_CONCURRENCY:
            Actor.log.warning(
                "max_concurrency=%d exceeds the cap of %d; clamping down to "
                "protect the shared LDA key's rate limit from a single run.",
                max_concurrency, MAX_ALLOWED_CONCURRENCY,
            )
            max_concurrency = MAX_ALLOWED_CONCURRENCY
        lda_max_pages: int | None = actor_input.get("lda_max_pages") or None
        max_filings_per_record: int = int(
            actor_input.get("max_filings_per_record", 100)
        )

        # LDA key: actor input wins, then LDA_API_KEY env var, else
        # anonymous. Never log the key itself — only which mode is used.
        lda_key, lda_key_mode = lda.resolve_api_key(actor_input.get("lda_api_key"))
        Actor.log.info(
            "LDA key mode: %s",
            {
                "input": "using user-provided key",
                "env": "using shared key",
                "anonymous": "anonymous mode",
            }[lda_key_mode],
        )
        if lda_key_mode == "anonymous":
            Actor.log.warning(
                "No LDA key available; expect slow runs and possible throttling."
            )

        Actor.log.info(
            "Run config: quarters=%s chambers=%s overlap_types=%s "
            "max_concurrency=%d lda_max_pages=%s",
            quarters, chambers, sorted(overlap_types),
            max_concurrency, lda_max_pages,
        )

        store = await Actor.open_key_value_store()
        crosswalk = Crosswalk.load()

        # --- Parallel fetch: roster + PTR datasets + every LDA quarter ---
        fetched_at = datetime.now(timezone.utc)
        results = await asyncio.gather(
            load_members(store),
            *(ptr.fetch_latest_items(chamber) for chamber in chambers),
            *(
                lda.fetch_quarter(
                    quarter,
                    max_concurrency=max_concurrency,
                    max_pages=lda_max_pages,
                    api_key=lda_key,
                )
                for quarter in quarters
            ),
        )
        (members, unmapped_committees) = results[0]
        ptr_items_per_chamber = results[1 : 1 + len(chambers)]
        lda_quarter_results: list[lda.QuarterResult] = results[1 + len(chambers) :]
        lda_per_quarter = [r.filings for r in lda_quarter_results]
        lda_throttled = any(r.throttled for r in lda_quarter_results)
        if lda_throttled:
            Actor.log.warning(
                "One or more LDA quarters were throttled; continuing with "
                "partial lobbying filings for those quarters."
            )

        # --- Adapt trades (needs the member index for name resolution) ---
        adapter = ptr.AdapterResult()
        for chamber, items in zip(chambers, ptr_items_per_chamber):
            partial = ptr.adapt_rows(items, members)
            adapter.member_trades.extend(partial.member_trades)
            adapter.skipped.extend(partial.skipped)
            adapter.unresolved_names.extend(partial.unresolved_names)
            Actor.log.info(
                "%s PTR: %d trades, %d skipped, %d unresolved names",
                chamber, len(partial.member_trades),
                len(partial.skipped), len(partial.unresolved_names),
            )
        adapter.unresolved_names = sorted(set(adapter.unresolved_names))

        # Keep only trades transacted inside the requested quarters.
        quarter_set = set(quarters)
        trades: list[MemberTrade] = [
            mt for mt in adapter.member_trades
            if quarter_of(mt.trade.transaction_date) in quarter_set
        ]
        Actor.log.info(
            "Trades in scope: %d of %d (quarters %s)",
            len(trades), len(adapter.member_trades), quarters,
        )

        filings: list[QuarterFiling] = [
            QuarterFiling(quarter, filing)
            for quarter, quarter_filings in zip(quarters, lda_per_quarter)
            for filing in quarter_filings
        ]
        Actor.log.info("Lobbying filings in scope: %d", len(filings))

        # --- Join (pure) ---
        result = build_overlaps(
            members=members,
            trades=trades,
            filings=filings,
            crosswalk=crosswalk,
            max_filings_per_record=max_filings_per_record,
        )
        records = [
            r for r in result.records if r.overlap_type.value in overlap_types
        ]

        # --- Dataset ---
        if records:
            await Actor.push_data([r.model_dump(mode="json") for r in records])
        by_type = {
            OverlapType.committee_match: sum(
                1 for r in records
                if r.overlap_type is OverlapType.committee_match
            ),
            OverlapType.sector_match_only: sum(
                1 for r in records
                if r.overlap_type is OverlapType.sector_match_only
            ),
        }

        # --- RUN_SUMMARY (always, even with zero overlaps) ---
        unmapped: list[UnmappedItem] = [
            *(UnmappedItem(kind="issue_code", value=v)
              for v in result.unmapped_issue_codes),
            *(UnmappedItem(kind="ticker", value=v)
              for v in result.unmapped_tickers),
            *(UnmappedItem(kind="committee", value=v)
              for v in sorted(unmapped_committees)),
            *(UnmappedItem(kind="member_name", value=v)
              for v in adapter.unresolved_names),
        ]
        summary = RunSummary(
            quarters_covered=quarters,
            members_scanned=len({mt.bioguide_id for mt in trades}),
            overlaps_by_type=by_type,
            unmapped=unmapped,
            source_freshness=[
                SourceFreshness(source="senate_lda", fetched_at=fetched_at),
                SourceFreshness(source="congress_trades_actors", fetched_at=fetched_at),
                SourceFreshness(source="congress_legislators", fetched_at=fetched_at),
            ],
            lda_throttled=lda_throttled,
        )
        await store.set_value("RUN_SUMMARY", summary.model_dump(mode="json"))

        Actor.log.info(
            "Done: %d overlap records (%d committee_match, %d sector_match_only), "
            "%d unmapped items, %d PTR rows skipped.",
            len(records),
            by_type[OverlapType.committee_match],
            by_type[OverlapType.sector_match_only],
            len(unmapped), len(adapter.skipped),
        )
