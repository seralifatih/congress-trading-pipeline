"""Pydantic v2 output schema for the lobbying/trades overlap actor.

Strict models: no `Any`, no silent coercion. Every field maps to a
concrete value in the output contract described in CLAUDE.md. Each
`OverlapRecord` is one (member, quarter, sector) overlap — not one per
trade and not one per filing.

Framing note (non-negotiable): these models describe *records*, not
signals. Field names stay neutral (`overlap`, `co_occurrence`). Nothing
here asserts wrongdoing.
"""

from __future__ import annotations

from datetime import date
from enum import Enum

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    NonNegativeInt,
    field_validator,
    model_validator,
)

# A strict base so every model rejects unknown keys and never coerces
# across types (e.g. "3" -> 3). This is what "strict, no Any" means in
# practice for pydantic v2.
_STRICT = ConfigDict(
    extra="forbid",
    strict=True,
    frozen=True,
    validate_assignment=True,
)


class Chamber(str, Enum):
    house = "house"
    senate = "senate"


class Party(str, Enum):
    democrat = "D"
    republican = "R"
    independent = "I"


class MappingConfidence(str, Enum):
    high = "high"
    medium = "medium"
    low = "low"


class OverlapType(str, Enum):
    # Lobbying targeted a committee the member sits on.
    committee_match = "committee_match"
    # Sector overlap only, no committee link.
    sector_match_only = "sector_match_only"


class TransactionType(str, Enum):
    purchase = "purchase"
    sale = "sale"
    exchange = "exchange"


class Trade(BaseModel):
    """One transaction from a Periodic Transaction Report (PTR) filing.

    `disclosure_lag_days` is derived at the record level, not here; this
    model just carries the two dates it is computed from.
    """

    model_config = _STRICT

    ptr_filing_id: str = Field(min_length=1)
    ptr_url: str = Field(min_length=1)
    ticker: str = Field(min_length=1)
    transaction_type: TransactionType
    amount_range: str = Field(
        min_length=1,
        description="Disclosed dollar band, verbatim, e.g. '$1,001 - $15,000'.",
    )
    transaction_date: date
    disclosure_date: date

    @model_validator(mode="after")
    def _disclosure_not_before_transaction(self) -> Trade:
        if self.disclosure_date < self.transaction_date:
            raise ValueError(
                "disclosure_date cannot precede transaction_date"
            )
        return self


class LobbyingFiling(BaseModel):
    """One LDA (LD-1/LD-2) filing relevant to this sector and quarter."""

    model_config = _STRICT

    lda_filing_uuid: str = Field(min_length=1)
    lda_url: str = Field(min_length=1)
    registrant: str = Field(min_length=1)
    client: str = Field(min_length=1)
    issue_codes: list[str] = Field(
        min_length=1,
        description="LDA general issue area codes, e.g. ['TAX', 'HCR'].",
    )
    amount_reported: float | None = Field(
        default=None,
        ge=0.0,
        description="Reported lobbying spend in USD; None if not disclosed.",
    )

    @field_validator("issue_codes")
    @classmethod
    def _codes_non_empty(cls, codes: list[str]) -> list[str]:
        if any(not code.strip() for code in codes):
            raise ValueError("issue_codes must not contain empty strings")
        return codes


class CommitteeAssignment(BaseModel):
    """A committee the member sat on during the quarter, with the
    jurisdiction tags used by the crosswalk to test for a committee match."""

    model_config = _STRICT

    committee_id: str = Field(min_length=1)
    committee_name: str = Field(min_length=1)
    jurisdiction_tags: list[str] = Field(
        min_length=1,
        description="Sector/jurisdiction tags for this committee.",
    )
    is_subcommittee: bool = False
    role: str | None = Field(
        default=None,
        description="e.g. 'Chair', 'Ranking Member', 'Member'.",
    )

    @field_validator("jurisdiction_tags")
    @classmethod
    def _tags_non_empty(cls, tags: list[str]) -> list[str]:
        if any(not tag.strip() for tag in tags):
            raise ValueError("jurisdiction_tags must not contain empty strings")
        return tags


class OverlapRecord(BaseModel):
    """One (member, quarter, sector) overlap — the unit of the dataset."""

    model_config = _STRICT

    # Member identity
    member_bioguide_id: str = Field(min_length=1)
    member_name: str = Field(min_length=1)
    chamber: Chamber
    party: Party
    state: str = Field(
        min_length=2,
        max_length=2,
        description="Two-letter USPS state code.",
    )

    # Time + sector join key
    quarter: str = Field(
        pattern=r"^\d{4}-Q[1-4]$",
        description="Calendar quarter, e.g. '2026-Q1'.",
    )
    sector: str = Field(min_length=1)

    # Crosswalk provenance — which rule fired and how confident it is.
    mapping_rule_id: str = Field(min_length=1)
    mapping_confidence: MappingConfidence

    # The three evidence lists. All required; a real overlap needs at
    # least one trade and one lobbying filing to exist.
    trades: list[Trade] = Field(min_length=1)
    lobbying: list[LobbyingFiling] = Field(min_length=1)
    lobbying_filing_count: NonNegativeInt = Field(
        description="Total filings matching this (quarter, sector). When "
        "greater than len(lobbying), the evidence list was capped to the "
        "filings with the largest reported amounts — truncation is always "
        "visible here, never silent.",
    )
    committees: list[CommitteeAssignment] = Field(default_factory=list)

    overlap_type: OverlapType

    disclosure_lag_days: NonNegativeInt = Field(
        description="Days from earliest trade date to its disclosure date.",
    )

    @model_validator(mode="after")
    def _committee_match_requires_committee(self) -> OverlapRecord:
        if self.overlap_type is OverlapType.committee_match and not self.committees:
            raise ValueError(
                "committee_match overlap requires at least one committee assignment"
            )
        return self

    @model_validator(mode="after")
    def _filing_count_covers_list(self) -> OverlapRecord:
        if self.lobbying_filing_count < len(self.lobbying):
            raise ValueError(
                "lobbying_filing_count cannot be smaller than the evidence list"
            )
        return self


class UnmappedItem(BaseModel):
    """An issue code or ticker the crosswalk could not resolve. Reported
    in the run summary, never silently dropped."""

    model_config = _STRICT

    kind: str = Field(description="'issue_code' or 'ticker'.")
    value: str = Field(min_length=1)
    occurrences: NonNegativeInt = 1


class SourceFreshness(BaseModel):
    """When each upstream source was last observed, for the run summary."""

    model_config = _STRICT

    source: str = Field(min_length=1)
    fetched_at: AwareDatetime
    latest_record_date: date | None = None


class RunSummary(BaseModel):
    """Written to the key-value store under RUN_SUMMARY. Describes coverage
    and gaps for one actor run — not part of the dataset itself."""

    model_config = _STRICT

    quarters_covered: list[str] = Field(default_factory=list)
    members_scanned: NonNegativeInt = 0
    overlaps_by_type: dict[OverlapType, NonNegativeInt] = Field(
        default_factory=dict
    )
    unmapped: list[UnmappedItem] = Field(default_factory=list)
    source_freshness: list[SourceFreshness] = Field(default_factory=list)
    lda_throttled: bool = Field(
        default=False,
        description="True if any LDA quarter gave up on a page after "
        "exhausting retries against a 429 — the run still completed with "
        "whatever filings were fetched before that point.",
    )

    @field_validator("quarters_covered")
    @classmethod
    def _quarters_well_formed(cls, quarters: list[str]) -> list[str]:
        import re

        pattern = re.compile(r"^\d{4}-Q[1-4]$")
        for quarter in quarters:
            if not pattern.match(quarter):
                raise ValueError(f"malformed quarter: {quarter!r}")
        return quarters
