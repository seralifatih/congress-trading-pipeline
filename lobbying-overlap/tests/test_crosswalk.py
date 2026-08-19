"""Tests for the crosswalk loader + resolver.

This is where bugs are most expensive (CLAUDE.md: "if the crosswalk is
wrong the whole product is wrong"), so coverage is deliberately dense:
real-file integrity, all three resolve directions, unmapped reporting,
normalization, and loader fail-fast behaviour on malformed files.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.crosswalk import (
    CROSSWALK_PATH,
    JURISDICTIONS_PATH,
    Crosswalk,
    CrosswalkError,
    Mapping,
    _norm_gics_key,
)
from src.models import MappingConfidence

# The 79 official LDA general issue area codes, fetched from
# lda.gov/api/v1/constants/filing/lobbyingactivityissues/ (2026-07).
# If the LDA adds codes, this list and data/crosswalk.yaml both change.
OFFICIAL_LDA_CODES = [
    "ACC", "ADV", "AER", "AGR", "ALC", "ANI", "APP", "ART", "AUT", "AVI",
    "BAN", "BNK", "BEV", "BUD", "CIV", "CHM", "CAW", "CDT", "COM", "CPI",
    "CON", "CSP", "CPT", "DEF", "DIS", "DOC", "ECN", "EDU", "ENG", "ENV",
    "FAM", "FIN", "FIR", "FOO", "FOR", "FUE", "GAM", "GOV", "HCR", "HOM",
    "HOU", "IMM", "IND", "INS", "INT", "LBR", "LAW", "MAN", "MAR", "MIA",
    "MED", "MMM", "MON", "NAT", "PHA", "POS", "RRR", "RES", "REL", "RET",
    "ROD", "SCI", "SMB", "SPO", "TAR", "TAX", "TEC", "TOB", "TOR", "TRD",
    "TRA", "TOU", "TRU", "URB", "UNM", "UTI", "VET", "WAS", "WEL",
]


@pytest.fixture(scope="module")
def xwalk() -> Crosswalk:
    return Crosswalk.load()


# ---------------------------------------------------------------------------
# Real-file integrity
# ---------------------------------------------------------------------------
class TestRealFiles:
    def test_loads(self, xwalk: Crosswalk) -> None:
        assert xwalk.sectors

    def test_official_code_list_is_79(self) -> None:
        assert len(OFFICIAL_LDA_CODES) == 79
        assert len(set(OFFICIAL_LDA_CODES)) == 79

    def test_every_official_code_present(self, xwalk: Crosswalk) -> None:
        missing = [c for c in OFFICIAL_LDA_CODES if not xwalk.is_known_issue_code(c)]
        assert not missing, f"crosswalk.yaml missing LDA codes: {missing}"

    def test_no_unknown_codes_in_yaml(self, xwalk: Crosswalk) -> None:
        official = set(OFFICIAL_LDA_CODES)
        extras = [c for c in xwalk._issue_rules if c not in official]
        assert not extras, f"crosswalk.yaml has non-official codes: {extras}"

    def test_committee_file_sectors_all_in_vocab(self, xwalk: Crosswalk) -> None:
        # Loader already validates; this documents the cross-file contract.
        for cid, rules in xwalk._committee_rules.items():
            for sector, _ in rules:
                assert sector in xwalk.sectors, f"{cid}: {sector}"

    def test_all_confidences_valid_enum(self, xwalk: Crosswalk) -> None:
        for rules in (
            *xwalk._issue_rules.values(),
            *xwalk._ticker_overrides.values(),
            *xwalk._gics_rules.values(),
            *xwalk._committee_rules.values(),
        ):
            for _, conf in rules:
                assert isinstance(conf, MappingConfidence)

    def test_all_eleven_gics_sectors_covered(self, xwalk: Crosswalk) -> None:
        expected = {
            "energy", "materials", "industrials", "consumer_discretionary",
            "consumer_staples", "health_care", "financials",
            "information_technology", "communication_services",
            "utilities", "real_estate",
        }
        assert set(xwalk._gics_rules) == expected


# ---------------------------------------------------------------------------
# Issue code resolution
# ---------------------------------------------------------------------------
class TestIssueCodes:
    def test_known_code(self, xwalk: Crosswalk) -> None:
        result = xwalk.resolve_issue_code("TAX")
        assert result == [
            Mapping("tax", "ic:TAX->tax", MappingConfidence.high)
        ]

    def test_case_and_whitespace_normalized(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_issue_code(" tax ") == xwalk.resolve_issue_code("TAX")

    def test_multi_sector_order_preserved(self, xwalk: Crosswalk) -> None:
        result = xwalk.resolve_issue_code("MED")
        assert [m.sector for m in result] == ["healthcare", "pharma"]
        assert all(m.confidence is MappingConfidence.high for m in result)

    def test_unknown_code_empty(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_issue_code("ZZZ") == []

    def test_intentional_empty_mapping(self, xwalk: Crosswalk) -> None:
        # REL is in the file but maps to no sector on purpose.
        assert xwalk.is_known_issue_code("REL")
        assert xwalk.resolve_issue_code("REL") == []

    def test_batch_reports_unmapped(self, xwalk: Crosswalk) -> None:
        resolved, unmapped = xwalk.resolve_issue_codes(["TAX", "ZZZ", "HCR"])
        assert set(resolved) == {"TAX", "HCR"}
        assert unmapped == ["ZZZ"]

    def test_batch_intentional_empty_not_unmapped(self, xwalk: Crosswalk) -> None:
        resolved, unmapped = xwalk.resolve_issue_codes(["REL"])
        assert resolved == {"REL": []}
        assert unmapped == []

    def test_batch_dedupes_input(self, xwalk: Crosswalk) -> None:
        resolved, unmapped = xwalk.resolve_issue_codes(
            ["TAX", "tax", " TAX ", "ZZZ", "zzz"]
        )
        assert list(resolved) == ["TAX"]
        assert unmapped == ["ZZZ"]

    def test_batch_empty_input(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_issue_codes([]) == ({}, [])

    def test_rule_id_format(self, xwalk: Crosswalk) -> None:
        for mapping in xwalk.resolve_issue_code("HCR"):
            assert mapping.rule_id == f"ic:HCR->{mapping.sector}"


# ---------------------------------------------------------------------------
# Ticker resolution
# ---------------------------------------------------------------------------
class TestTickers:
    def test_override(self, xwalk: Crosswalk) -> None:
        result = xwalk.resolve_ticker("NVDA")
        assert result == [
            Mapping("technology", "tk:NVDA->technology", MappingConfidence.high)
        ]

    def test_override_case_normalized(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_ticker("nvda") == xwalk.resolve_ticker("NVDA")

    def test_gics_fallback(self, xwalk: Crosswalk) -> None:
        result = xwalk.resolve_ticker("OBSCURE", gics_sector="Health Care")
        assert [m.sector for m in result] == ["healthcare", "pharma"]
        assert result[0].rule_id == "gics:health_care->healthcare"

    def test_gics_input_normalization(self, xwalk: Crosswalk) -> None:
        variants = ["Health Care", "health care", "HEALTH-CARE", "health_care"]
        results = [xwalk.resolve_ticker("XYZ", gics_sector=v) for v in variants]
        assert all(r == results[0] for r in results)
        assert results[0] != []

    def test_override_beats_gics(self, xwalk: Crosswalk) -> None:
        # LMT is overridden to defense/aerospace; a (wrong) GICS hint of
        # Industrials must not win.
        result = xwalk.resolve_ticker("LMT", gics_sector="Industrials")
        assert {m.sector for m in result} == {"defense", "aerospace"}
        assert all(m.rule_id.startswith("tk:LMT->") for m in result)

    def test_unknown_no_gics_empty(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_ticker("OBSCURE") == []

    def test_unknown_gics_sector_empty(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_ticker("OBSCURE", gics_sector="Not A Sector") == []

    def test_batch_reports_unmapped(self, xwalk: Crosswalk) -> None:
        resolved, unmapped = xwalk.resolve_tickers(
            ["NVDA", "OBSCURE", "WEIRD"],
            gics_lookup={"WEIRD": "Utilities"},
        )
        assert set(resolved) == {"NVDA", "WEIRD"}
        assert unmapped == ["OBSCURE"]

    def test_batch_gics_lookup_key_normalized(self, xwalk: Crosswalk) -> None:
        resolved, unmapped = xwalk.resolve_tickers(
            ["weird "], gics_lookup={"WEIRD": "Utilities"}
        )
        assert set(resolved) == {"WEIRD"}
        assert unmapped == []

    def test_batch_empty_input(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_tickers([]) == ({}, [])


# ---------------------------------------------------------------------------
# Committee resolution
# ---------------------------------------------------------------------------
class TestCommittees:
    def test_parent_committee(self, xwalk: Crosswalk) -> None:
        result = xwalk.resolve_committee("HSAS")
        assert {m.sector for m in result} == {"defense", "aerospace"}
        # List-form jurisdictions default to high confidence.
        assert all(m.confidence is MappingConfidence.high for m in result)

    def test_subcommittee_inherits_parent(self, xwalk: Crosswalk) -> None:
        parent = xwalk.resolve_committee("HSAS")
        sub = xwalk.resolve_committee("HSAS28")
        assert sub == parent  # including rule_id pointing at the parent row

    def test_subcommittee_rule_id_names_parent(self, xwalk: Crosswalk) -> None:
        for mapping in xwalk.resolve_committee("HSAS28"):
            assert mapping.rule_id == f"com:HSAS->{mapping.sector}"

    def test_case_normalized(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_committee("hsas") == xwalk.resolve_committee("HSAS")

    def test_unknown_committee_empty(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_committee("XXXX") == []

    def test_unknown_subcommittee_of_unknown_parent(self, xwalk: Crosswalk) -> None:
        assert xwalk.resolve_committee("XXXX99") == []

    def test_batch_reports_unmapped(self, xwalk: Crosswalk) -> None:
        resolved, unmapped = xwalk.resolve_committees(["HSAS", "XXXX", "SSFI"])
        assert set(resolved) == {"HSAS", "SSFI"}
        assert unmapped == ["XXXX"]


# ---------------------------------------------------------------------------
# Loader fail-fast on malformed files
# ---------------------------------------------------------------------------
MINIMAL_JURISDICTIONS = """
version: 1
committees:
  HSAS:
    name: Test Armed Services
    sectors: [defense]
"""

MINIMAL_CROSSWALK = """
version: 1
sectors: [defense, tax]
issue_codes:
  TAX:
    name: Taxation
    sectors: {tax: high}
"""


def _write(tmp_path: Path, name: str, content: str) -> Path:
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return path


class TestLoaderValidation:
    def test_minimal_valid_files_load(self, tmp_path: Path) -> None:
        cw = _write(tmp_path, "cw.yaml", MINIMAL_CROSSWALK)
        jd = _write(tmp_path, "jd.yaml", MINIMAL_JURISDICTIONS)
        xwalk = Crosswalk.load(cw, jd)
        assert xwalk.resolve_issue_code("TAX")[0].sector == "tax"

    def test_unknown_sector_in_issue_code_raises(self, tmp_path: Path) -> None:
        bad = MINIMAL_CROSSWALK.replace("{tax: high}", "{bogus: high}")
        cw = _write(tmp_path, "cw.yaml", bad)
        jd = _write(tmp_path, "jd.yaml", MINIMAL_JURISDICTIONS)
        with pytest.raises(CrosswalkError, match="bogus"):
            Crosswalk.load(cw, jd)

    def test_invalid_confidence_raises(self, tmp_path: Path) -> None:
        bad = MINIMAL_CROSSWALK.replace("{tax: high}", "{tax: certain}")
        cw = _write(tmp_path, "cw.yaml", bad)
        jd = _write(tmp_path, "jd.yaml", MINIMAL_JURISDICTIONS)
        with pytest.raises(CrosswalkError, match="certain"):
            Crosswalk.load(cw, jd)

    def test_missing_sectors_section_raises(self, tmp_path: Path) -> None:
        bad = MINIMAL_CROSSWALK.replace("sectors: [defense, tax]\n", "")
        cw = _write(tmp_path, "cw.yaml", bad)
        jd = _write(tmp_path, "jd.yaml", MINIMAL_JURISDICTIONS)
        with pytest.raises(CrosswalkError, match="sectors"):
            Crosswalk.load(cw, jd)

    def test_duplicate_sector_vocab_raises(self, tmp_path: Path) -> None:
        bad = MINIMAL_CROSSWALK.replace(
            "sectors: [defense, tax]", "sectors: [defense, tax, tax]"
        )
        cw = _write(tmp_path, "cw.yaml", bad)
        jd = _write(tmp_path, "jd.yaml", MINIMAL_JURISDICTIONS)
        with pytest.raises(CrosswalkError, match="duplicate"):
            Crosswalk.load(cw, jd)

    def test_non_snake_case_sector_raises(self, tmp_path: Path) -> None:
        bad = MINIMAL_CROSSWALK.replace(
            "sectors: [defense, tax]", 'sectors: [defense, tax, "Bad Sector"]'
        )
        cw = _write(tmp_path, "cw.yaml", bad)
        jd = _write(tmp_path, "jd.yaml", MINIMAL_JURISDICTIONS)
        with pytest.raises(CrosswalkError, match="snake_case"):
            Crosswalk.load(cw, jd)

    def test_reserved_unmapped_sector_raises(self, tmp_path: Path) -> None:
        bad = MINIMAL_CROSSWALK.replace(
            "sectors: [defense, tax]", "sectors: [defense, tax, unmapped]"
        )
        cw = _write(tmp_path, "cw.yaml", bad)
        jd = _write(tmp_path, "jd.yaml", MINIMAL_JURISDICTIONS)
        with pytest.raises(CrosswalkError, match="reserved"):
            Crosswalk.load(cw, jd)

    def test_committee_sector_not_in_vocab_raises(self, tmp_path: Path) -> None:
        cw = _write(tmp_path, "cw.yaml", MINIMAL_CROSSWALK)
        bad = MINIMAL_JURISDICTIONS.replace("[defense]", "[nonexistent]")
        jd = _write(tmp_path, "jd.yaml", bad)
        with pytest.raises(CrosswalkError, match="nonexistent"):
            Crosswalk.load(cw, jd)

    def test_committee_dict_confidence_form(self, tmp_path: Path) -> None:
        cw = _write(tmp_path, "cw.yaml", MINIMAL_CROSSWALK)
        jd = _write(
            tmp_path,
            "jd.yaml",
            MINIMAL_JURISDICTIONS.replace(
                "sectors: [defense]", "sectors: {defense: medium}"
            ),
        )
        xwalk = Crosswalk.load(cw, jd)
        result = xwalk.resolve_committee("HSAS")
        assert result == [
            Mapping("defense", "com:HSAS->defense", MappingConfidence.medium)
        ]

    def test_committee_duplicate_list_sectors_raises(self, tmp_path: Path) -> None:
        cw = _write(tmp_path, "cw.yaml", MINIMAL_CROSSWALK)
        bad = MINIMAL_JURISDICTIONS.replace("[defense]", "[defense, defense]")
        jd = _write(tmp_path, "jd.yaml", bad)
        with pytest.raises(CrosswalkError, match="duplicate"):
            Crosswalk.load(cw, jd)

    def test_empty_issue_codes_raises(self, tmp_path: Path) -> None:
        bad = MINIMAL_CROSSWALK.split("issue_codes:")[0] + "issue_codes: {}\n"
        cw = _write(tmp_path, "cw.yaml", bad)
        jd = _write(tmp_path, "jd.yaml", MINIMAL_JURISDICTIONS)
        with pytest.raises(CrosswalkError, match="issue_codes"):
            Crosswalk.load(cw, jd)

    def test_committee_missing_sectors_key_raises(self, tmp_path: Path) -> None:
        cw = _write(tmp_path, "cw.yaml", MINIMAL_CROSSWALK)
        jd = _write(
            tmp_path,
            "jd.yaml",
            "version: 1\ncommittees:\n  HSAS:\n    name: No sectors here\n",
        )
        with pytest.raises(CrosswalkError, match="HSAS"):
            Crosswalk.load(cw, jd)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
class TestNormalization:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Health Care", "health_care"),
            ("  Information Technology ", "information_technology"),
            ("REAL-ESTATE", "real_estate"),
            ("utilities", "utilities"),
        ],
    )
    def test_norm_gics_key(self, raw: str, expected: str) -> None:
        assert _norm_gics_key(raw) == expected

    def test_default_paths_exist(self) -> None:
        assert CROSSWALK_PATH.exists()
        assert JURISDICTIONS_PATH.exists()
