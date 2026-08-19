"""The join: trades × lobbying filings × committee membership → overlaps.

Pure functions only — no network, no filesystem, no Apify. Everything
this module needs is passed in, which is what makes it testable; the
pipeline in main.py does the fetching and hands the data here.

Granularity: one `OverlapRecord` per (member, quarter, sector) — not one
per trade, not one per filing (CLAUDE.md output contract).

`overlap_type` semantics:
- `committee_match`  — the member sits on at least one committee whose
  jurisdiction (per the crosswalk) includes the overlap sector. That is
  the operational meaning of "lobbying targeted a committee they sit on":
  LDA filings disclose target chambers/agencies, not specific committees,
  so committee targeting is resolved through sector jurisdiction.
- `sector_match_only` — sector overlap exists but no committee link.

Framing reminder: overlap ≠ wrongdoing. This module records co-occurrence
in the filings; it does not interpret it.
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import date

if __package__:
    from .crosswalk import Crosswalk, Mapping
    from .models import (
        LobbyingFiling,
        MappingConfidence,
        OverlapRecord,
        OverlapType,
        Trade,
    )
    from .sources.legislators import Member
else:  # pragma: no cover - loose-script fallback
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from crosswalk import Crosswalk, Mapping  # type: ignore[no-redefine]
    from models import (  # type: ignore[no-redefine]
        LobbyingFiling,
        MappingConfidence,
        OverlapRecord,
        OverlapType,
        Trade,
    )
    from sources.legislators import Member  # type: ignore[no-redefine]

logger = logging.getLogger(__name__)

# Lower is stronger; used to pick the primary mapping rule for a record.
_CONFIDENCE_ORDER: dict[MappingConfidence, int] = {
    MappingConfidence.high: 0,
    MappingConfidence.medium: 1,
    MappingConfidence.low: 2,
}


@dataclass(frozen=True)
class MemberTrade:
    """A PTR trade attributed to a member. The quarter is derived from
    the transaction date, not passed in."""

    bioguide_id: str
    trade: Trade


@dataclass(frozen=True)
class QuarterFiling:
    """A lobbying filing tagged with the quarter it covers. The LDA
    fetch is per-quarter, so the pipeline already knows this."""

    quarter: str
    filing: LobbyingFiling


@dataclass(frozen=True)
class OverlapResult:
    """Join output plus everything that did NOT resolve — unmapped
    inputs are reported, never silently dropped (CLAUDE.md)."""

    records: list[OverlapRecord]
    unmapped_tickers: list[str] = field(default_factory=list)
    unmapped_issue_codes: list[str] = field(default_factory=list)
    unknown_member_ids: list[str] = field(default_factory=list)


def quarter_of(d: date) -> str:
    """date(2026, 2, 14) -> '2026-Q1'."""
    return f"{d.year}-Q{(d.month - 1) // 3 + 1}"


def _best_mapping(a: Mapping, b: Mapping) -> Mapping:
    """Deterministically pick the stronger of two mappings for the same
    sector: higher confidence wins, then lexicographic rule_id."""
    ka = (_CONFIDENCE_ORDER[a.confidence], a.rule_id)
    kb = (_CONFIDENCE_ORDER[b.confidence], b.rule_id)
    return a if ka <= kb else b


def _filing_evidence_key(filing: LobbyingFiling) -> tuple[bool, float, str]:
    """Sort key for capping: largest reported amounts first, unreported
    (null) amounts last, uuid as the deterministic tiebreak."""
    return (
        filing.amount_reported is None,
        -(filing.amount_reported or 0.0),
        filing.lda_filing_uuid,
    )


def build_overlaps(
    *,
    members: dict[str, Member],
    trades: list[MemberTrade],
    filings: list[QuarterFiling],
    crosswalk: Crosswalk,
    gics_lookup: dict[str, str] | None = None,
    max_filings_per_record: int = 100,
) -> OverlapResult:
    """Join trades and lobbying filings on (quarter, sector).

    - `members`: bioguide_id -> Member (with committee assignments).
    - `gics_lookup`: optional ticker -> GICS sector name, for the
      crosswalk's GICS fallback on tickers with no explicit override.
    - `max_filings_per_record`: cap on the lobbying evidence list per
      record (popular sectors can attract 1000+ filings a quarter, which
      would blow past dataset item size limits). The filings with the
      largest reported amounts are kept; `lobbying_filing_count` on the
      record always carries the uncapped total, so truncation is visible.

    A record is emitted only when a member's trade sector has at least
    one lobbying filing in the same quarter. Trades in sectors nobody
    lobbied that quarter produce no record.
    """
    gics_lookup = {
        k.strip().upper(): v for k, v in (gics_lookup or {}).items()
    }

    unmapped_tickers: set[str] = set()
    unknown_member_ids: set[str] = set()

    # --- trade side: (bioguide, quarter, sector) -> trades + best rule ---
    grouped_trades: dict[tuple[str, str, str], list[Trade]] = {}
    primary_rule: dict[tuple[str, str, str], Mapping] = {}

    for member_trade in trades:
        bioguide = member_trade.bioguide_id
        if bioguide not in members:
            unknown_member_ids.add(bioguide)
            continue
        trade = member_trade.trade
        ticker = trade.ticker.strip().upper()
        mappings = crosswalk.resolve_ticker(ticker, gics_lookup.get(ticker))
        if not mappings:
            unmapped_tickers.add(ticker)
            continue
        quarter = quarter_of(trade.transaction_date)
        for mapping in mappings:
            key = (bioguide, quarter, mapping.sector)
            grouped_trades.setdefault(key, []).append(trade)
            existing = primary_rule.get(key)
            primary_rule[key] = (
                mapping if existing is None else _best_mapping(existing, mapping)
            )

    # --- lobbying side: (quarter, sector) -> {uuid: filing} (dedup: one
    # filing can reach the same sector via several issue codes) ---
    unmapped_codes: set[str] = set()
    filings_by_sector: dict[tuple[str, str], dict[str, LobbyingFiling]] = {}

    for quarter_filing in filings:
        filing = quarter_filing.filing
        sectors: set[str] = set()
        for code in filing.issue_codes:
            norm = code.strip().upper()
            if not crosswalk.is_known_issue_code(norm):
                unmapped_codes.add(norm)
                continue
            sectors.update(
                m.sector for m in crosswalk.resolve_issue_code(norm)
            )
        for sector in sectors:
            bucket = filings_by_sector.setdefault(
                (quarter_filing.quarter, sector), {}
            )
            bucket[filing.lda_filing_uuid] = filing

    # --- join ---
    records: list[OverlapRecord] = []
    for key in sorted(grouped_trades):
        bioguide, quarter, sector = key
        sector_filings = filings_by_sector.get((quarter, sector))
        if not sector_filings:
            continue  # nobody lobbied this sector this quarter — no overlap

        member = members[bioguide]

        # Committee link: assignments whose crosswalk jurisdiction covers
        # this sector. Only the matched assignments go on the record —
        # they are the evidence for committee_match.
        matched_committees = [
            assignment
            for assignment in member.committees
            if any(
                m.sector == sector
                for m in crosswalk.resolve_committee(assignment.committee_id)
            )
        ]
        overlap_type = (
            OverlapType.committee_match
            if matched_committees
            else OverlapType.sector_match_only
        )

        record_trades = sorted(
            grouped_trades[key],
            key=lambda t: (t.transaction_date, t.ticker, t.ptr_filing_id),
        )
        earliest = min(record_trades, key=lambda t: t.transaction_date)
        lag_days = (earliest.disclosure_date - earliest.transaction_date).days

        all_filings = sorted(sector_filings.values(), key=_filing_evidence_key)
        evidence = sorted(
            all_filings[:max_filings_per_record],
            key=lambda f: f.lda_filing_uuid,
        )
        if len(all_filings) > len(evidence):
            logger.debug(
                "record %s/%s/%s: lobbying evidence capped %d -> %d",
                bioguide, quarter, sector, len(all_filings), len(evidence),
            )

        rule = primary_rule[key]
        records.append(
            OverlapRecord(
                member_bioguide_id=member.bioguide_id,
                member_name=member.name,
                chamber=member.chamber,
                party=member.party,
                state=member.state,
                quarter=quarter,
                sector=sector,
                mapping_rule_id=rule.rule_id,
                mapping_confidence=rule.confidence,
                trades=record_trades,
                lobbying=evidence,
                lobbying_filing_count=len(all_filings),
                committees=matched_committees,
                overlap_type=overlap_type,
                disclosure_lag_days=lag_days,
            )
        )

    logger.info(
        "overlap join: %d records (%d committee_match), "
        "%d unmapped tickers, %d unmapped issue codes, %d unknown members",
        len(records),
        sum(1 for r in records if r.overlap_type is OverlapType.committee_match),
        len(unmapped_tickers),
        len(unmapped_codes),
        len(unknown_member_ids),
    )
    return OverlapResult(
        records=records,
        unmapped_tickers=sorted(unmapped_tickers),
        unmapped_issue_codes=sorted(unmapped_codes),
        unknown_member_ids=sorted(unknown_member_ids),
    )
