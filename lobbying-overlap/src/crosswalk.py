"""Crosswalk loader + resolver — the core asset of this product.

Resolves three vocabularies onto one sector vocabulary:

    1. LDA general issue codes  -> sector   (data/crosswalk.yaml)
    2. Traded tickers           -> sector   (data/crosswalk.yaml;
                                             explicit overrides, then GICS)
    3. Committees               -> sector   (data/committee_jurisdictions.yaml)

Every resolved mapping carries a derived, auditable `rule_id`
(`ic:HCR->healthcare`, `tk:LMT->defense`, `gics:health_care->pharma`,
`com:HSAS->defense`) and a `confidence` (high/medium/low).

Unmapped inputs are never silently dropped: batch resolvers return them
in a separate list so the run summary can report them.

Loading is fail-fast: a sector referenced anywhere that is not in the
`sectors` vocabulary, an invalid confidence, or a malformed section
raises `CrosswalkError`. If this file is wrong the whole product is
wrong — better to refuse to run than to run wrong.
"""

from __future__ import annotations

import logging
import os
import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import yaml

if __package__:
    from .models import MappingConfidence
else:  # pragma: no cover - loose-script fallback
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from models import MappingConfidence  # type: ignore[no-redefine]

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[1]
CROSSWALK_PATH = _REPO_ROOT / "data" / "crosswalk.yaml"
JURISDICTIONS_PATH = _REPO_ROOT / "data" / "committee_jurisdictions.yaml"

_SECTOR_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# Confidence assigned to committee jurisdiction tags given in plain list
# form (no explicit per-sector confidence).
_COMMITTEE_DEFAULT_CONFIDENCE = MappingConfidence.high

# The runtime placeholder tag legislators.py uses for committees missing
# from the jurisdictions file. Never a real sector.
_UNMAPPED_TAG = "unmapped"


class CrosswalkError(RuntimeError):
    """Malformed or internally inconsistent crosswalk data files."""


@dataclass(frozen=True)
class Mapping:
    """One resolved (input -> sector) edge, with provenance."""

    sector: str
    rule_id: str
    confidence: MappingConfidence


def _norm_gics_key(name: str) -> str:
    """'Health Care' -> 'health_care'. Used for both file keys and input."""
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def _parse_sector_map(
    raw: object, *, context: str, vocab: set[str]
) -> list[tuple[str, MappingConfidence]]:
    """Validate a {sector: confidence} mapping (or [] / {}). Order preserved.

    Also accepts a plain list of sectors (committee jurisdictions list
    form), which gets the default committee confidence.
    """
    if raw is None:
        raise CrosswalkError(f"{context}: sectors section missing")

    pairs: list[tuple[str, str]]
    if isinstance(raw, dict):
        pairs = [(str(k), str(v)) for k, v in raw.items()]
    elif isinstance(raw, list):
        if len(set(raw)) != len(raw):
            raise CrosswalkError(f"{context}: duplicate sectors in list")
        pairs = [(str(s), _COMMITTEE_DEFAULT_CONFIDENCE.value) for s in raw]
    else:
        raise CrosswalkError(
            f"{context}: sectors must be a mapping or list, got {type(raw).__name__}"
        )

    out: list[tuple[str, MappingConfidence]] = []
    for sector, conf_raw in pairs:
        if sector not in vocab:
            raise CrosswalkError(
                f"{context}: sector {sector!r} not in the sectors vocabulary"
            )
        try:
            confidence = MappingConfidence(conf_raw)
        except ValueError as exc:
            raise CrosswalkError(
                f"{context}: invalid confidence {conf_raw!r} for sector "
                f"{sector!r} (expected high/medium/low)"
            ) from exc
        out.append((sector, confidence))
    return out


class Crosswalk:
    """Loaded, validated crosswalk. Construct via `Crosswalk.load()`."""

    def __init__(
        self,
        *,
        sectors: list[str],
        issue_rules: dict[str, list[tuple[str, MappingConfidence]]],
        ticker_overrides: dict[str, list[tuple[str, MappingConfidence]]],
        gics_rules: dict[str, list[tuple[str, MappingConfidence]]],
        committee_rules: dict[str, list[tuple[str, MappingConfidence]]],
    ) -> None:
        self.sectors: frozenset[str] = frozenset(sectors)
        self._issue_rules = issue_rules
        self._ticker_overrides = ticker_overrides
        self._gics_rules = gics_rules
        self._committee_rules = committee_rules

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------
    @classmethod
    def load(
        cls,
        crosswalk_path: Path = CROSSWALK_PATH,
        jurisdictions_path: Path = JURISDICTIONS_PATH,
    ) -> Crosswalk:
        with crosswalk_path.open(encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
        if not isinstance(doc, dict):
            raise CrosswalkError(f"{crosswalk_path}: not a mapping at top level")

        # --- sector vocabulary ---
        raw_sectors = doc.get("sectors")
        if not isinstance(raw_sectors, list) or not raw_sectors:
            raise CrosswalkError(f"{crosswalk_path}: 'sectors' must be a non-empty list")
        sectors = [str(s) for s in raw_sectors]
        if len(set(sectors)) != len(sectors):
            dupes = sorted({s for s in sectors if sectors.count(s) > 1})
            raise CrosswalkError(f"{crosswalk_path}: duplicate sectors {dupes}")
        for sector in sectors:
            if not _SECTOR_RE.match(sector):
                raise CrosswalkError(
                    f"{crosswalk_path}: sector {sector!r} is not snake_case"
                )
        if _UNMAPPED_TAG in sectors:
            raise CrosswalkError(
                f"{crosswalk_path}: {_UNMAPPED_TAG!r} is reserved, not a sector"
            )
        vocab = set(sectors)

        # --- issue codes ---
        raw_codes = doc.get("issue_codes")
        if not isinstance(raw_codes, dict) or not raw_codes:
            raise CrosswalkError(
                f"{crosswalk_path}: 'issue_codes' must be a non-empty mapping"
            )
        issue_rules: dict[str, list[tuple[str, MappingConfidence]]] = {}
        for code, entry in raw_codes.items():
            code = str(code).upper()
            if not isinstance(entry, dict):
                raise CrosswalkError(
                    f"{crosswalk_path}: issue code {code}: entry must be a mapping"
                )
            issue_rules[code] = _parse_sector_map(
                entry.get("sectors", {}),
                context=f"{crosswalk_path}: issue code {code}",
                vocab=vocab,
            )

        # --- tickers ---
        raw_tickers = doc.get("tickers") or {}
        if not isinstance(raw_tickers, dict):
            raise CrosswalkError(f"{crosswalk_path}: 'tickers' must be a mapping")
        ticker_overrides: dict[str, list[tuple[str, MappingConfidence]]] = {}
        for ticker, sector_map in (raw_tickers.get("overrides") or {}).items():
            ticker = str(ticker).upper()
            ticker_overrides[ticker] = _parse_sector_map(
                sector_map,
                context=f"{crosswalk_path}: ticker override {ticker}",
                vocab=vocab,
            )
        gics_rules: dict[str, list[tuple[str, MappingConfidence]]] = {}
        for gics_name, sector_map in (raw_tickers.get("gics") or {}).items():
            key = _norm_gics_key(str(gics_name))
            if key in gics_rules:
                raise CrosswalkError(
                    f"{crosswalk_path}: GICS key {gics_name!r} normalizes to a "
                    f"duplicate of an earlier key"
                )
            gics_rules[key] = _parse_sector_map(
                sector_map,
                context=f"{crosswalk_path}: GICS {gics_name}",
                vocab=vocab,
            )

        # --- committees (separate hand-edited file) ---
        with jurisdictions_path.open(encoding="utf-8") as fh:
            jdoc = yaml.safe_load(fh)
        raw_committees = (
            jdoc.get("committees") if isinstance(jdoc, dict) else None
        )
        if not isinstance(raw_committees, dict) or not raw_committees:
            raise CrosswalkError(
                f"{jurisdictions_path}: 'committees' must be a non-empty mapping"
            )
        committee_rules: dict[str, list[tuple[str, MappingConfidence]]] = {}
        for cid, entry in raw_committees.items():
            cid = str(cid).upper()
            if not isinstance(entry, dict):
                raise CrosswalkError(
                    f"{jurisdictions_path}: committee {cid}: entry must be a mapping"
                )
            committee_rules[cid] = _parse_sector_map(
                entry.get("sectors"),
                context=f"{jurisdictions_path}: committee {cid}",
                vocab=vocab,
            )

        logger.info(
            "crosswalk loaded: %d sectors, %d issue codes, %d ticker overrides, "
            "%d GICS rules, %d committees",
            len(vocab), len(issue_rules), len(ticker_overrides),
            len(gics_rules), len(committee_rules),
        )
        return cls(
            sectors=sectors,
            issue_rules=issue_rules,
            ticker_overrides=ticker_overrides,
            gics_rules=gics_rules,
            committee_rules=committee_rules,
        )

    # ------------------------------------------------------------------
    # Single-input resolvers. Empty list = no sector mapping. Use the
    # batch resolvers when you need unmapped inputs reported.
    # ------------------------------------------------------------------
    def resolve_issue_code(self, code: str) -> list[Mapping]:
        code = code.strip().upper()
        rules = self._issue_rules.get(code)
        if rules is None:
            return []
        return [
            Mapping(sector, f"ic:{code}->{sector}", conf)
            for sector, conf in rules
        ]

    def is_known_issue_code(self, code: str) -> bool:
        """True if the code exists in the file — including codes that
        intentionally map to no sector (e.g. REL)."""
        return code.strip().upper() in self._issue_rules

    def resolve_ticker(
        self, ticker: str, gics_sector: str | None = None
    ) -> list[Mapping]:
        ticker = ticker.strip().upper()
        override = self._ticker_overrides.get(ticker)
        if override is not None:
            return [
                Mapping(sector, f"tk:{ticker}->{sector}", conf)
                for sector, conf in override
            ]
        if gics_sector is not None:
            key = _norm_gics_key(gics_sector)
            rules = self._gics_rules.get(key)
            if rules is not None:
                return [
                    Mapping(sector, f"gics:{key}->{sector}", conf)
                    for sector, conf in rules
                ]
        return []

    def resolve_committee(self, committee_id: str) -> list[Mapping]:
        """Committee thomas_id -> sectors. Subcommittees (HSAS28) inherit
        the parent (HSAS); the rule_id names the parent so the fired row
        is the one actually in the file."""
        cid = committee_id.strip().upper()
        rule_cid = cid
        rules = self._committee_rules.get(cid)
        if rules is None and len(cid) > 4:
            rule_cid = cid[:4]
            rules = self._committee_rules.get(rule_cid)
        if rules is None:
            return []
        return [
            Mapping(sector, f"com:{rule_cid}->{sector}", conf)
            for sector, conf in rules
        ]

    # ------------------------------------------------------------------
    # Batch resolvers — return (resolved, unmapped). Unmapped inputs are
    # reported, never dropped. "Resolved to zero sectors on purpose"
    # (issue code present with empty sectors) is NOT unmapped.
    # ------------------------------------------------------------------
    def resolve_issue_codes(
        self, codes: Iterable[str]
    ) -> tuple[dict[str, list[Mapping]], list[str]]:
        resolved: dict[str, list[Mapping]] = {}
        unmapped: list[str] = []
        for code in codes:
            norm = code.strip().upper()
            if norm in resolved or norm in unmapped:
                continue
            if not self.is_known_issue_code(norm):
                unmapped.append(norm)
                continue
            resolved[norm] = self.resolve_issue_code(norm)
        return resolved, unmapped

    def resolve_tickers(
        self,
        tickers: Iterable[str],
        gics_lookup: dict[str, str] | None = None,
    ) -> tuple[dict[str, list[Mapping]], list[str]]:
        """`gics_lookup` optionally maps ticker -> GICS sector name for
        the fallback path."""
        gics_lookup = gics_lookup or {}
        gics_norm = {k.strip().upper(): v for k, v in gics_lookup.items()}
        resolved: dict[str, list[Mapping]] = {}
        unmapped: list[str] = []
        for ticker in tickers:
            norm = ticker.strip().upper()
            if norm in resolved or norm in unmapped:
                continue
            mappings = self.resolve_ticker(norm, gics_norm.get(norm))
            if mappings:
                resolved[norm] = mappings
            else:
                unmapped.append(norm)
        return resolved, unmapped

    def resolve_committees(
        self, committee_ids: Iterable[str]
    ) -> tuple[dict[str, list[Mapping]], list[str]]:
        resolved: dict[str, list[Mapping]] = {}
        unmapped: list[str] = []
        for cid in committee_ids:
            norm = cid.strip().upper()
            if norm in resolved or norm in unmapped:
                continue
            mappings = self.resolve_committee(norm)
            if mappings:
                resolved[norm] = mappings
            else:
                unmapped.append(norm)
        return resolved, unmapped
