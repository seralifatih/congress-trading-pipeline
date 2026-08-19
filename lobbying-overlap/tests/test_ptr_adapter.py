"""Tests for the PTR adapter (src/sources/ptr.py) — pure mapping parts.

No network: map_row / adapt_rows / NameResolver only.
"""

from __future__ import annotations

from datetime import date

from src.models import Chamber, Party, TransactionType
from src.sources.legislators import Member
from src.sources.ptr import (
    FALLBACK_PTR_URL,
    NameResolver,
    SkippedRow,
    _amount_range,
    adapt_rows,
    map_row,
)

HOUSE_ROW = {
    "id": "4d6016b44239f646476ffac6798f21ae3e32c8ed75ea6c5b50a0bbdf9e5d3296",
    "politician": "Mark Alford",
    "transaction_date": "2026-03-16",
    "filing_date": "2026-03-31",
    "ticker": "AMZN",
    "asset_name": "Amazon.com, Inc. - Common Stock",
    "asset_type": "Stock",
    "type": "sell",
    "amount_min": 1001,
    "amount_max": 15000,
    "owner": "self",
}

SENATE_ROW = {
    "id": "a3f-c1",
    "filer_name": "Nancy Pelosi",
    "filer_type": "congress",
    "trade_type": "purchase",
    "ticker": "NVDA",
    "asset_name": "NVIDIA Corporation",
    "asset_type": "Stock",
    "amount_low": 1000001,
    "amount_high": 5000000,
    "amount_midpoint": 3000000,
    "trade_date": "2026-04-29",
    "filing_date": "2026-04-29",
    "owner": "joint",
    "is_active": True,
}


def make_member(
    bioguide: str, name: str, chamber: Chamber = Chamber.house
) -> Member:
    return Member(
        bioguide_id=bioguide,
        name=name,
        chamber=chamber,
        party=Party.republican,
        state="MO",
        committees=[],
    )


# ---------------------------------------------------------------------------
# map_row — house format
# ---------------------------------------------------------------------------
class TestHouseRow:
    def test_maps(self) -> None:
        mapped = map_row(HOUSE_ROW)
        assert not isinstance(mapped, SkippedRow)
        name, trade = mapped
        assert name == "Mark Alford"
        assert trade.ptr_filing_id == HOUSE_ROW["id"]
        assert trade.ticker == "AMZN"
        assert trade.transaction_type is TransactionType.sale  # sell -> sale
        assert trade.amount_range == "$1,001 - $15,000"
        assert trade.transaction_date == date(2026, 3, 16)
        assert trade.disclosure_date == date(2026, 3, 31)

    def test_fallback_ptr_url(self) -> None:
        _, trade = map_row(HOUSE_ROW)  # type: ignore[misc]
        assert trade.ptr_url == FALLBACK_PTR_URL["house"]

    def test_explicit_ptr_url_wins(self) -> None:
        row = {**HOUSE_ROW, "ptr_url": "https://clerk.example/filing/123"}
        _, trade = map_row(row)  # type: ignore[misc]
        assert trade.ptr_url == "https://clerk.example/filing/123"


# ---------------------------------------------------------------------------
# map_row — senate format
# ---------------------------------------------------------------------------
class TestSenateRow:
    def test_maps(self) -> None:
        mapped = map_row(SENATE_ROW)
        assert not isinstance(mapped, SkippedRow)
        name, trade = mapped
        assert name == "Nancy Pelosi"
        assert trade.ticker == "NVDA"
        assert trade.transaction_type is TransactionType.purchase
        assert trade.amount_range == "$1,000,001 - $5,000,000"
        assert trade.transaction_date == date(2026, 4, 29)
        assert trade.disclosure_date == date(2026, 4, 29)
        assert trade.ptr_url == FALLBACK_PTR_URL["senate"]

    def test_inactive_row_skipped(self) -> None:
        row = {**SENATE_ROW, "is_active": False}
        mapped = map_row(row)
        assert isinstance(mapped, SkippedRow)
        assert "inactive" in mapped.reason


# ---------------------------------------------------------------------------
# map_row — skip reasons
# ---------------------------------------------------------------------------
class TestSkips:
    def test_no_ticker(self) -> None:
        for bad in (None, "", "--", "N/A"):
            mapped = map_row({**HOUSE_ROW, "ticker": bad})
            assert isinstance(mapped, SkippedRow)
            assert "ticker" in mapped.reason

    def test_unknown_transaction_type(self) -> None:
        mapped = map_row({**HOUSE_ROW, "type": "gift"})
        assert isinstance(mapped, SkippedRow)
        assert "gift" in mapped.reason

    def test_bad_dates(self) -> None:
        mapped = map_row({**HOUSE_ROW, "transaction_date": "not-a-date"})
        assert isinstance(mapped, SkippedRow)
        assert "dates" in mapped.reason

    def test_disclosure_before_transaction(self) -> None:
        # Model validator rejects; adapter reports instead of crashing.
        mapped = map_row(
            {**HOUSE_ROW, "transaction_date": "2026-03-16", "filing_date": "2026-03-01"}
        )
        assert isinstance(mapped, SkippedRow)
        assert "validation" in mapped.reason

    def test_unrecognized_shape(self) -> None:
        mapped = map_row({"id": "x", "foo": "bar"})
        assert isinstance(mapped, SkippedRow)
        assert "shape" in mapped.reason

    def test_missing_amounts(self) -> None:
        mapped = map_row({**HOUSE_ROW, "amount_min": None, "amount_max": None})
        assert isinstance(mapped, SkippedRow)
        assert "amount" in mapped.reason


# ---------------------------------------------------------------------------
# amount formatting
# ---------------------------------------------------------------------------
class TestAmountRange:
    def test_both_bounds(self) -> None:
        assert _amount_range(1001, 15000) == "$1,001 - $15,000"

    def test_open_ended(self) -> None:
        assert _amount_range(50000001, None) == "$50,000,001+"

    def test_missing_low(self) -> None:
        assert _amount_range(None, 15000) is None


# ---------------------------------------------------------------------------
# Name resolution
# ---------------------------------------------------------------------------
class TestNameResolver:
    def test_exact_match(self) -> None:
        members = {"A000001": make_member("A000001", "Mark Alford")}
        assert NameResolver(members).resolve("Mark Alford") == "A000001"

    def test_case_and_accents(self) -> None:
        members = {"S001234": make_member("S001234", "María Elvira Salazar")}
        resolver = NameResolver(members)
        assert resolver.resolve("maria elvira salazar") == "S001234"

    def test_middle_name_fallback(self) -> None:
        members = {"B000001": make_member("B000001", "James E. Banks")}
        assert NameResolver(members).resolve("James Banks") == "B000001"

    def test_suffix_stripped(self) -> None:
        members = {"C000001": make_member("C000001", "Charles J. Fleischmann Jr.")}
        assert NameResolver(members).resolve("Charles Fleischmann") == "C000001"

    def test_ambiguous_fallback_does_not_resolve(self) -> None:
        members = {
            "X000001": make_member("X000001", "John A. Smith"),
            "X000002": make_member("X000002", "John B. Smith"),
        }
        resolver = NameResolver(members)
        # Exact forms still work; bare "John Smith" is ambiguous.
        assert resolver.resolve("John A. Smith") == "X000001"
        assert resolver.resolve("John Smith") is None

    def test_unknown_name(self) -> None:
        members = {"A000001": make_member("A000001", "Mark Alford")}
        assert NameResolver(members).resolve("Nobody Nowhere") is None

    def test_nickname_formal_mismatch(self) -> None:
        # Real production case: roster has "Rick W. Allen" (first: Rick,
        # no formal name anywhere in the data), House PTR source
        # publishes "Richard W. Allen".
        members = {"A000372": make_member("A000372", "Rick W. Allen")}
        resolver = NameResolver(members)
        assert resolver.resolve("Richard W. Allen") == "A000372"
        assert resolver.resolve("Rick Allen") == "A000372"

    def test_nickname_reverse_direction(self) -> None:
        # Roster formal, source nickname.
        members = {"M000001": make_member("M000001", "Michael Smith")}
        assert NameResolver(members).resolve("Mike Smith") == "M000001"

    def test_alias_resolution(self) -> None:
        # Buddy Carter case: nickname not in the static table, but the
        # roster's first name ships as an alias.
        member = Member(
            bioguide_id="C001103",
            name="Buddy Carter",
            chamber=Chamber.house,
            party=Party.republican,
            state="GA",
            committees=[],
            aliases=["Earl Carter"],
        )
        resolver = NameResolver({"C001103": member})
        assert resolver.resolve("Earl L. Carter") == "C001103"
        assert resolver.resolve("Buddy Carter") == "C001103"

    def test_alias_does_not_create_false_ambiguity(self) -> None:
        # A member's own name + alias share a fallback key — must still
        # resolve (set semantics, not list counting).
        member = Member(
            bioguide_id="A000372",
            name="Rick W. Allen",
            chamber=Chamber.house,
            party=Party.republican,
            state="GA",
            committees=[],
            aliases=["Rick Allen"],
        )
        resolver = NameResolver({"A000372": member})
        assert resolver.resolve("Richard Allen") == "A000372"


# ---------------------------------------------------------------------------
# adapt_rows — end to end (pure)
# ---------------------------------------------------------------------------
class TestAdaptRows:
    def test_mixed_batch(self) -> None:
        members = {
            "A000001": make_member("A000001", "Mark Alford"),
            "P000197": make_member("P000197", "Nancy Pelosi"),
        }
        items = [
            HOUSE_ROW,
            {"count": 1, "data": [SENATE_ROW]},  # wrapped export shape
            {**HOUSE_ROW, "id": "bad1", "ticker": "--"},
            {**HOUSE_ROW, "id": "u1", "politician": "Unknown Person"},
        ]
        result = adapt_rows(items, members)
        assert len(result.member_trades) == 2
        assert {mt.bioguide_id for mt in result.member_trades} == {
            "A000001", "P000197",
        }
        assert [s.row_id for s in result.skipped] == ["bad1"]
        assert result.unresolved_names == ["Unknown Person"]

    def test_empty_input(self) -> None:
        result = adapt_rows([], {})
        assert result.member_trades == []
        assert result.skipped == []
        assert result.unresolved_names == []

    def test_fallback_url_follows_member_chamber(self) -> None:
        # Production case: source actors emit house-shaped rows for BOTH
        # chambers. A senator parsed from a house-shaped row must get the
        # Senate disclosure portal as fallback, not the House one.
        members = {
            "B001236": make_member(
                "B001236", "John Boozman", chamber=Chamber.senate
            ),
        }
        row = {**HOUSE_ROW, "id": "s-row", "politician": "John Boozman"}
        result = adapt_rows([row], members)
        assert len(result.member_trades) == 1
        assert result.member_trades[0].trade.ptr_url == FALLBACK_PTR_URL["senate"]

    def test_explicit_url_never_rewritten(self) -> None:
        members = {
            "B001236": make_member(
                "B001236", "John Boozman", chamber=Chamber.senate
            ),
        }
        row = {
            **HOUSE_ROW,
            "id": "s-row2",
            "politician": "John Boozman",
            "ptr_url": "https://efdsearch.senate.gov/search/view/ptr/abc123/",
        }
        result = adapt_rows([row], members)
        assert (
            result.member_trades[0].trade.ptr_url
            == "https://efdsearch.senate.gov/search/view/ptr/abc123/"
        )
