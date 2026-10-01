"""Tests for the 2.0 output changes: traceability, match_level, LDA amount
status, deterministic cap fallback, primary mapping, bioguide-first join."""

from __future__ import annotations

from datetime import date

import pytest

from src.crosswalk import Crosswalk
from src.models import (
    AmountStatus,
    Chamber,
    MemberResolution,
    PtrUrlKind,
    TransactionType,
)
from src.overlap import MemberTrade, QuarterFiling, build_overlaps
from src.sources.lda import map_filing
from src.sources.ptr import FALLBACK_PTR_URL, adapt_rows, map_row
from tests.test_overlap import make_filing, make_member, make_trade
from tests.test_ptr_adapter import HOUSE_ROW, make_member as roster_member

PDF = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035143.pdf"


@pytest.fixture(scope="module")
def xwalk() -> Crosswalk:
    return Crosswalk.load()


# --- A. traceability ---------------------------------------------------
class TestTraceability:
    def test_house_pdf_url_carried_through(self) -> None:
        row = {**HOUSE_ROW, "pdf_url": PDF, "filing_id": "20035143"}
        _, _, trade = map_row(row)  # type: ignore[misc]
        assert trade.ptr_url == PDF
        assert trade.ptr_url_kind is PtrUrlKind.document
        assert trade.ptr_filing_id == "20035143"
        assert trade.tracker_row_id == HOUSE_ROW["id"]

    def test_null_pdf_url_falls_back_and_says_so(self) -> None:
        row = {**HOUSE_ROW, "pdf_url": None, "filing_id": "uuid-1"}
        _, _, trade = map_row(row)  # type: ignore[misc]
        assert trade.ptr_url == FALLBACK_PTR_URL["house"]
        assert trade.ptr_url_kind is PtrUrlKind.portal_fallback
        assert trade.ptr_filing_id == "uuid-1"

    def test_senate_member_gets_senate_portal_not_invented_url(self) -> None:
        members = {"B001236": roster_member("B001236", "John Boozman", Chamber.senate)}
        row = {
            **HOUSE_ROW, "politician": "John Boozman", "pdf_url": None,
            "filing_id": "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab",
        }
        trade = adapt_rows([row], members).member_trades[0].trade
        assert trade.ptr_url == FALLBACK_PTR_URL["senate"]
        assert trade.ptr_url_kind is PtrUrlKind.portal_fallback
        assert trade.ptr_filing_id == "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab"


# --- B. match level ----------------------------------------------------
def test_every_record_is_sector_level(xwalk: Crosswalk) -> None:
    member = make_member()
    result = build_overlaps(
        members={member.bioguide_id: member},
        trades=[MemberTrade(member.bioguide_id, make_trade("LMT"))],
        filings=[QuarterFiling("2026-Q1", make_filing("u1", ["DEF"]))],
        crosswalk=xwalk,
    )
    assert result.records
    assert all(r.match_level == "sector" for r in result.records)
    assert all(r.model_dump(mode="json")["match_level"] == "sector" for r in result.records)


# --- C. LDA amounts ----------------------------------------------------
def _raw(filing_type: str, income: object = None, expenses: object = None) -> dict:
    return {
        "filing_uuid": "u-1", "url": "https://lda.gov/api/v1/filings/u-1/",
        "filing_type": filing_type, "dt_posted": "2026-04-14T13:52:41-04:00",
        "income": income, "expenses": expenses,
        "registrant": {"name": "R"}, "client": {"name": "C"},
        "lobbying_activities": [{"general_issue_code": "TAX"}],
    }


class TestLdaAmounts:
    def test_income_parsed(self) -> None:
        f = map_filing(_raw("Q2", income="45000.00"))
        assert f and f.amount_reported == 45000.0
        assert f.amount_reported_status is AmountStatus.reported
        assert f.filing_posted_date == date(2026, 4, 14)

    def test_expenses_used_when_no_income(self) -> None:
        f = map_filing(_raw("Q2", expenses="12000.00"))
        assert f and f.amount_reported == 12000.0

    def test_registration_null_is_structural(self) -> None:
        f = map_filing(_raw("RR"))
        assert f and f.amount_reported is None
        assert f.amount_reported_status is AmountStatus.not_applicable_registration

    def test_report_with_null_is_not_reported(self) -> None:
        f = map_filing(_raw("Q2"))
        assert f and f.amount_reported_status is AmountStatus.not_reported


class TestCapFallback:
    def test_all_null_cap_is_deterministic_by_posted_date_then_uuid(
        self, xwalk: Crosswalk
    ) -> None:
        def filing(uuid: str, posted: date | None):
            f = make_filing(uuid, ["DEF"], amount=None)
            return f.model_copy(update={"filing_posted_date": posted})

        filings = [
            filing("c", date(2026, 4, 1)),
            filing("a", date(2026, 6, 1)),
            filing("b", date(2026, 6, 1)),
            filing("z", None),
        ]
        member = make_member()
        outs = []
        for order in (filings, list(reversed(filings))):
            res = build_overlaps(
                members={member.bioguide_id: member},
                trades=[MemberTrade(member.bioguide_id, make_trade("LMT"))],
                filings=[QuarterFiling("2026-Q1", f) for f in order],
                crosswalk=xwalk, max_filings_per_record=2,
            )
            rec = next(r for r in res.records if r.sector == "defense")
            outs.append([f.lda_filing_uuid for f in rec.lobbying])
        # newest two (a, b — tie broken by uuid), regardless of input order
        assert outs[0] == outs[1] == ["a", "b"]


# --- D. primary mapping ------------------------------------------------
class TestPrimaryMapping:
    def _records(self, xwalk: Crosswalk, ticker: str, codes_by_sector: list[str]):
        member = make_member()
        res = build_overlaps(
            members={member.bioguide_id: member},
            trades=[MemberTrade(member.bioguide_id, make_trade(ticker))],
            filings=[
                QuarterFiling("2026-Q1", make_filing(f"u{i}", [c]))
                for i, c in enumerate(codes_by_sector)
            ],
            crosswalk=xwalk,
        )
        return res.records

    def test_exactly_one_primary_per_trade(self, xwalk: Crosswalk) -> None:
        # JNJ -> healthcare + pharma (both high): lobbying in both.
        records = self._records(xwalk, "JNJ", ["HCR", "PHA"])
        assert len(records) >= 2
        primaries = [t for r in records for t in r.trades if t.is_primary_mapping]
        assert len(primaries) == 1
        assert sum(r.is_primary_mapping for r in records) == 1

    def test_higher_confidence_wins(self, xwalk: Crosswalk) -> None:
        # HD -> retail (high) beats construction (medium).
        sectors = {m.sector: m.confidence for m in xwalk.resolve_ticker("HD")}
        assert {"retail", "construction"} <= set(sectors)
        records = self._records(xwalk, "HD", ["HOU", "CSP"])
        by_sector = {r.sector: r for r in records}
        assert by_sector["retail"].is_primary_mapping
        assert not by_sector["construction"].is_primary_mapping

    def test_rows_not_removed(self, xwalk: Crosswalk) -> None:
        assert len(self._records(xwalk, "JNJ", ["HCR", "PHA"])) >= 2


# --- E. vocabulary -----------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "expected"),
    [("buy", TransactionType.buy), ("sell", TransactionType.sell),
     ("exchange", TransactionType.exchange), ("purchase", TransactionType.buy),
     ("Sale (Partial)", TransactionType.sell)],
)
def test_transaction_vocabulary(raw: str, expected: TransactionType) -> None:
    _, _, trade = map_row({**HOUSE_ROW, "type": raw})  # type: ignore[misc]
    assert trade.transaction_type is expected


def test_filing_type_case_insensitive() -> None:
    _, _, trade = map_row({**HOUSE_ROW, "filing_type": " Amendment "})  # type: ignore[misc]
    assert trade.filing_type is not None and trade.filing_type.value == "amendment"


# --- G. bioguide join --------------------------------------------------
class TestBioguideJoin:
    def test_bioguide_wins_over_name(self) -> None:
        members = {
            "M000355": roster_member("M000355", "Mitch McConnell", Chamber.senate),
        }
        row = {
            **HOUSE_ROW, "politician": "A. Mitchell McConnell, Jr.",
            "member_bioguide_id": "M000355",
        }
        res = adapt_rows([row], members)
        assert res.unresolved_names == []
        assert res.member_trades[0].bioguide_id == "M000355"
        assert res.member_trades[0].trade.member_resolution is MemberResolution.bioguide_id
        assert res.name_fallback_names == []

    def test_name_fallback_reported(self) -> None:
        members = {"A000372": roster_member("A000372", "Mark Alford")}
        row = {**HOUSE_ROW, "member_bioguide_id": None}
        res = adapt_rows([row], members)
        assert res.member_trades[0].trade.member_resolution is MemberResolution.name
        assert res.name_fallback_names == ["Mark Alford"]

    def test_id_not_in_roster_falls_back_to_name(self) -> None:
        members = {"A000372": roster_member("A000372", "Mark Alford")}
        row = {**HOUSE_ROW, "member_bioguide_id": "X999999"}
        res = adapt_rows([row], members)
        assert res.member_trades[0].bioguide_id == "A000372"
        assert res.member_trades[0].trade.member_resolution is MemberResolution.name

    def test_unresolvable_reported(self) -> None:
        res = adapt_rows([{**HOUSE_ROW, "member_bioguide_id": None}], {})
        assert res.unresolved_names == ["Mark Alford"]
        assert res.rows_read == 1
