"""Tests for the pure join in src/overlap.py.

Uses the real crosswalk files (they are part of the product), so known
mappings hold: LMT -> defense+aerospace, DEF -> defense+aerospace,
TAX -> tax, HSAS -> defense+aerospace.
"""

from __future__ import annotations

from datetime import date

import pytest

from src.crosswalk import Crosswalk
from src.models import (
    Chamber,
    CommitteeAssignment,
    LobbyingFiling,
    MappingConfidence,
    OverlapType,
    Party,
    Trade,
    TransactionType,
)
from src.overlap import (
    MemberTrade,
    OverlapResult,
    QuarterFiling,
    build_overlaps,
    quarter_of,
)
from src.sources.legislators import Member


@pytest.fixture(scope="module")
def xwalk() -> Crosswalk:
    return Crosswalk.load()


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------
HSAS = CommitteeAssignment(
    committee_id="HSAS",
    committee_name="House Committee on Armed Services",
    jurisdiction_tags=["defense", "aerospace"],
    is_subcommittee=False,
    role="Member",
)


def make_member(
    bioguide: str = "D000001",
    committees: list[CommitteeAssignment] | None = None,
) -> Member:
    return Member(
        bioguide_id=bioguide,
        name="Jane Doe",
        chamber=Chamber.house,
        party=Party.republican,
        state="TX",
        committees=committees or [],
    )


def make_trade(
    ticker: str = "LMT",
    tx: date = date(2026, 1, 5),
    disclosed: date = date(2026, 2, 4),
    filing_id: str = "PTR-1",
) -> Trade:
    return Trade(
        ptr_filing_id=filing_id,
        ptr_url=f"https://example.gov/{filing_id}",
        ticker=ticker,
        transaction_type=TransactionType.purchase,
        amount_range="$1,001 - $15,000",
        transaction_date=tx,
        disclosure_date=disclosed,
    )


def make_filing(
    uuid: str = "uuid-1",
    issue_codes: list[str] | None = None,
    amount: float | None = 100000.0,
) -> LobbyingFiling:
    return LobbyingFiling(
        lda_filing_uuid=uuid,
        lda_url=f"https://lda.gov/api/v1/filings/{uuid}/",
        registrant="Reg LLC",
        client="Client Corp",
        issue_codes=issue_codes or ["DEF"],
        amount_reported=amount,
    )


def run(
    members: dict[str, Member],
    trades: list[MemberTrade],
    filings: list[QuarterFiling],
    xwalk: Crosswalk,
    **kwargs: dict[str, str],
) -> OverlapResult:
    return build_overlaps(
        members=members, trades=trades, filings=filings,
        crosswalk=xwalk, **kwargs,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# quarter_of
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("d", "expected"),
    [
        (date(2026, 1, 1), "2026-Q1"),
        (date(2026, 3, 31), "2026-Q1"),
        (date(2026, 4, 1), "2026-Q2"),
        (date(2026, 6, 30), "2026-Q2"),
        (date(2026, 7, 1), "2026-Q3"),
        (date(2026, 9, 30), "2026-Q3"),
        (date(2026, 10, 1), "2026-Q4"),
        (date(2026, 12, 31), "2026-Q4"),
    ],
)
def test_quarter_of(d: date, expected: str) -> None:
    assert quarter_of(d) == expected


# ---------------------------------------------------------------------------
# Core join behaviour
# ---------------------------------------------------------------------------
class TestJoin:
    def test_committee_match(self, xwalk: Crosswalk) -> None:
        member = make_member(committees=[HSAS])
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("LMT"))],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["DEF"]))],
            xwalk,
        )
        # LMT -> defense + aerospace; DEF filing covers both sectors;
        # HSAS jurisdiction covers both -> two committee_match records.
        assert {r.sector for r in result.records} == {"defense", "aerospace"}
        for record in result.records:
            assert record.overlap_type is OverlapType.committee_match
            assert [c.committee_id for c in record.committees] == ["HSAS"]

    def test_sector_match_only_without_committee(self, xwalk: Crosswalk) -> None:
        member = make_member(committees=[])
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("LMT"))],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["DEF"]))],
            xwalk,
        )
        assert result.records
        for record in result.records:
            assert record.overlap_type is OverlapType.sector_match_only
            assert record.committees == []

    def test_committee_in_unrelated_sector_is_not_a_match(
        self, xwalk: Crosswalk
    ) -> None:
        # Member sits on Ways & Means (tax/trade/healthcare) but trades
        # defense: sector overlap exists, committee link does not.
        hswm = CommitteeAssignment(
            committee_id="HSWM",
            committee_name="House Committee on Ways and Means",
            jurisdiction_tags=["tax", "trade", "healthcare"],
            is_subcommittee=False,
            role="Member",
        )
        member = make_member(committees=[hswm])
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("LMT"))],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["DEF"]))],
            xwalk,
        )
        for record in result.records:
            assert record.overlap_type is OverlapType.sector_match_only

    def test_no_filing_in_sector_no_record(self, xwalk: Crosswalk) -> None:
        member = make_member(committees=[HSAS])
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("LMT"))],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["TAX"]))],
            xwalk,
        )
        assert result.records == []

    def test_quarter_mismatch_no_record(self, xwalk: Crosswalk) -> None:
        member = make_member(committees=[HSAS])
        result = run(
            {member.bioguide_id: member},
            # Trade transacts in Q1 (disclosure in Q2 is irrelevant).
            [MemberTrade(member.bioguide_id, make_trade("LMT"))],
            [QuarterFiling("2026-Q2", make_filing(issue_codes=["DEF"]))],
            xwalk,
        )
        assert result.records == []

    def test_trade_quarter_from_transaction_date(self, xwalk: Crosswalk) -> None:
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(
                member.bioguide_id,
                make_trade("LMT", tx=date(2026, 4, 2), disclosed=date(2026, 5, 1)),
            )],
            [QuarterFiling("2026-Q2", make_filing(issue_codes=["DEF"]))],
            xwalk,
        )
        assert result.records
        assert all(r.quarter == "2026-Q2" for r in result.records)

    def test_one_record_per_member_quarter_sector(self, xwalk: Crosswalk) -> None:
        # Two defense trades + two defense filings -> still ONE defense
        # record carrying both trades and both filings.
        member = make_member(committees=[HSAS])
        result = run(
            {member.bioguide_id: member},
            [
                MemberTrade(member.bioguide_id, make_trade("LMT", filing_id="PTR-1")),
                MemberTrade(
                    member.bioguide_id,
                    make_trade("NOC", tx=date(2026, 2, 1), filing_id="PTR-2"),
                ),
            ],
            [
                QuarterFiling("2026-Q1", make_filing("uuid-1", ["DEF"])),
                QuarterFiling("2026-Q1", make_filing("uuid-2", ["DEF"])),
            ],
            xwalk,
        )
        defense = [r for r in result.records if r.sector == "defense"]
        assert len(defense) == 1
        assert len(defense[0].trades) == 2
        assert [f.lda_filing_uuid for f in defense[0].lobbying] == [
            "uuid-1", "uuid-2",
        ]

    def test_filing_dedup_when_two_codes_hit_same_sector(
        self, xwalk: Crosswalk
    ) -> None:
        # DEF and AER both map to aerospace — the filing must appear once.
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("BA"))],
            [QuarterFiling("2026-Q1", make_filing("uuid-1", ["DEF", "AER"]))],
            xwalk,
        )
        aero = next(r for r in result.records if r.sector == "aerospace")
        assert len(aero.lobbying) == 1

    def test_multi_sector_ticker_multiple_records(self, xwalk: Crosswalk) -> None:
        # UNH -> healthcare + insurance; lobbying in both sectors.
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("UNH"))],
            [
                QuarterFiling("2026-Q1", make_filing("uuid-1", ["HCR"])),
                QuarterFiling("2026-Q1", make_filing("uuid-2", ["INS"])),
            ],
            xwalk,
        )
        assert {r.sector for r in result.records} >= {"healthcare", "insurance"}


# ---------------------------------------------------------------------------
# disclosure_lag_days
# ---------------------------------------------------------------------------
class TestDisclosureLag:
    def test_lag_days(self, xwalk: Crosswalk) -> None:
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(
                member.bioguide_id,
                make_trade("LMT", tx=date(2026, 1, 5), disclosed=date(2026, 2, 4)),
            )],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["DEF"]))],
            xwalk,
        )
        assert all(r.disclosure_lag_days == 30 for r in result.records)

    def test_lag_uses_earliest_trade(self, xwalk: Crosswalk) -> None:
        member = make_member()
        early = make_trade(
            "LMT", tx=date(2026, 1, 5), disclosed=date(2026, 1, 15),
            filing_id="PTR-early",
        )  # lag 10
        late = make_trade(
            "NOC", tx=date(2026, 2, 1), disclosed=date(2026, 3, 20),
            filing_id="PTR-late",
        )  # lag 47
        result = run(
            {member.bioguide_id: member},
            [
                MemberTrade(member.bioguide_id, late),
                MemberTrade(member.bioguide_id, early),
            ],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["DEF"]))],
            xwalk,
        )
        defense = next(r for r in result.records if r.sector == "defense")
        assert defense.disclosure_lag_days == 10
        # Trades sorted by transaction date.
        assert [t.ptr_filing_id for t in defense.trades] == [
            "PTR-early", "PTR-late",
        ]


# ---------------------------------------------------------------------------
# Unmapped / unknown reporting — never silent
# ---------------------------------------------------------------------------
class TestReporting:
    def test_unmapped_ticker_reported(self, xwalk: Crosswalk) -> None:
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("ZZZZZ"))],
            [],
            xwalk,
        )
        assert result.records == []
        assert result.unmapped_tickers == ["ZZZZZ"]

    def test_gics_lookup_rescues_ticker(self, xwalk: Crosswalk) -> None:
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("ZZZZZ"))],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["FUE"]))],
            xwalk,
            gics_lookup={"ZZZZZ": "Energy"},
        )
        assert result.unmapped_tickers == []
        assert {r.sector for r in result.records} == {"energy"}
        assert all(
            r.mapping_rule_id == "gics:energy->energy" for r in result.records
        )

    def test_unmapped_issue_code_reported(self, xwalk: Crosswalk) -> None:
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["WTF"]))],
            xwalk,
        )
        assert result.unmapped_issue_codes == ["WTF"]

    def test_unknown_member_reported(self, xwalk: Crosswalk) -> None:
        result = run(
            {},
            [MemberTrade("NOBODY1", make_trade("LMT"))],
            [],
            xwalk,
        )
        assert result.records == []
        assert result.unknown_member_ids == ["NOBODY1"]

    def test_intentionally_sectorless_code_not_unmapped(
        self, xwalk: Crosswalk
    ) -> None:
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["REL"]))],
            xwalk,
        )
        assert result.unmapped_issue_codes == []


# ---------------------------------------------------------------------------
# Evidence capping — lobbying_filing_count always carries the real total
# ---------------------------------------------------------------------------
class TestFilingCap:
    def _run_with_filings(
        self, xwalk: Crosswalk, filings: list[LobbyingFiling], cap: int
    ):
        member = make_member()
        return build_overlaps(
            members={member.bioguide_id: member},
            trades=[MemberTrade(member.bioguide_id, make_trade("LMT"))],
            filings=[QuarterFiling("2026-Q1", f) for f in filings],
            crosswalk=xwalk,
            max_filings_per_record=cap,
        )

    def test_no_truncation_below_cap(self, xwalk: Crosswalk) -> None:
        filings = [make_filing(f"u-{i}") for i in range(3)]
        result = self._run_with_filings(xwalk, filings, cap=10)
        record = next(r for r in result.records if r.sector == "defense")
        assert len(record.lobbying) == 3
        assert record.lobbying_filing_count == 3

    def test_cap_keeps_largest_amounts(self, xwalk: Crosswalk) -> None:
        filings = [
            make_filing("u-null", amount=None),
            make_filing("u-small", amount=5000.0),
            make_filing("u-big", amount=900000.0),
            make_filing("u-mid", amount=40000.0),
        ]
        result = self._run_with_filings(xwalk, filings, cap=2)
        record = next(r for r in result.records if r.sector == "defense")
        # Largest two amounts kept; final list re-sorted by uuid for
        # stable reading order.
        assert {f.lda_filing_uuid for f in record.lobbying} == {"u-big", "u-mid"}
        assert record.lobbying_filing_count == 4

    def test_cap_null_amounts_dropped_first(self, xwalk: Crosswalk) -> None:
        filings = [
            make_filing("u-null1", amount=None),
            make_filing("u-null2", amount=None),
            make_filing("u-paid", amount=100.0),
        ]
        result = self._run_with_filings(xwalk, filings, cap=2)
        record = next(r for r in result.records if r.sector == "defense")
        kept = {f.lda_filing_uuid for f in record.lobbying}
        assert "u-paid" in kept
        assert record.lobbying_filing_count == 3

    def test_cap_deterministic_on_ties(self, xwalk: Crosswalk) -> None:
        filings = [make_filing(f"u-{i}", amount=None) for i in range(5)]
        r1 = self._run_with_filings(xwalk, filings, cap=3)
        r2 = self._run_with_filings(xwalk, list(reversed(filings)), cap=3)
        k1 = [f.lda_filing_uuid for r in r1.records for f in r.lobbying]
        k2 = [f.lda_filing_uuid for r in r2.records for f in r.lobbying]
        assert k1 == k2


# ---------------------------------------------------------------------------
# Mapping provenance + determinism
# ---------------------------------------------------------------------------
class TestProvenance:
    def test_primary_rule_is_trade_side(self, xwalk: Crosswalk) -> None:
        member = make_member()
        result = run(
            {member.bioguide_id: member},
            [MemberTrade(member.bioguide_id, make_trade("LMT"))],
            [QuarterFiling("2026-Q1", make_filing(issue_codes=["DEF"]))],
            xwalk,
        )
        defense = next(r for r in result.records if r.sector == "defense")
        assert defense.mapping_rule_id == "tk:LMT->defense"
        assert defense.mapping_confidence is MappingConfidence.high

    def test_output_sorted_and_deterministic(self, xwalk: Crosswalk) -> None:
        m1 = make_member("A000001")
        m2 = make_member("B000002")
        members = {m.bioguide_id: m for m in (m1, m2)}
        trades = [
            MemberTrade("B000002", make_trade("LMT")),
            MemberTrade("A000001", make_trade("LMT")),
        ]
        filings = [QuarterFiling("2026-Q1", make_filing(issue_codes=["DEF"]))]
        r1 = run(members, trades, filings, xwalk)
        r2 = run(members, trades[::-1], filings, xwalk)  # reversed input order
        keys1 = [(r.member_bioguide_id, r.quarter, r.sector) for r in r1.records]
        keys2 = [(r.member_bioguide_id, r.quarter, r.sector) for r in r2.records]
        assert keys1 == keys2 == sorted(keys1)
