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
from typing import Literal

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
    # Same vocabulary as the House/Senate tracker actors (buy/sell/exchange).
    # Before 2.0 this actor emitted purchase/sale — see CHANGELOG.
    buy = "buy"
    sell = "sell"
    exchange = "exchange"


class PtrUrlKind(str, Enum):
    """What `Trade.ptr_url` points at — so a consumer never has to guess
    whether the link is the filing itself or a generic landing page."""

    document = "document"  # the filing's own PDF, as emitted by the tracker
    portal_fallback = "portal_fallback"  # generic disclosure search page


class MemberResolution(str, Enum):
    """How a trade was attributed to a member."""

    bioguide_id = "bioguide_id"  # tracker's member_bioguide_id (preferred)
    name = "name"  # display-name fallback — less reliable


class AmountStatus(str, Enum):
    reported = "reported"
    # LD-1 registrations (filing_type RR/RA) carry no income/expenses by
    # design — the source is null because the form has no such field.
    not_applicable_registration = "not_applicable_registration"
    # A report-type filing whose income and expenses are both null in the
    # source (e.g. below the reporting threshold, or not disclosed).
    not_reported = "not_reported"


class FilingType(str, Enum):
    original = "original"
    amendment = "amendment"


class Trade(BaseModel):
    """One transaction from a Periodic Transaction Report (PTR) filing.

    `disclosure_lag_days` is derived at the record level, not here; this
    model just carries the two dates it is computed from.
    """

    model_config = _STRICT

    ptr_filing_id: str = Field(
        min_length=1,
        description="The filing's own id from the tracker (`filing_id`: House "
        "DocID, Senate filing UUID) — shared by every trade in that filing. "
        "Falls back to `tracker_row_id` only if the tracker row has no "
        "filing_id.",
    )
    tracker_row_id: str = Field(
        min_length=1,
        description="The tracker dataset row's `id` (sha256 hash, one per "
        "transaction row). Stable join key back to the tracker dataset.",
    )
    ptr_url: str = Field(min_length=1)
    ptr_url_kind: PtrUrlKind = Field(
        description="'document' = the filing's own PDF (House); "
        "'portal_fallback' = generic disclosure search page, used when the "
        "tracker supplies no per-filing URL (all Senate rows today).",
    )
    member_resolution: MemberResolution = Field(
        default=MemberResolution.bioguide_id,
        description="How this trade was attributed to the member: the "
        "tracker's member_bioguide_id, or a display-name fallback.",
    )
    is_primary_mapping: bool = Field(
        default=True,
        description="A ticker can map to several sectors (HD -> retail AND "
        "construction), so one trade appears in several records. Exactly "
        "one of those appearances has is_primary_mapping=true: the sector "
        "with the strongest crosswalk rule (confidence high > medium > low, "
        "then lexicographic rule_id). Count only primary appearances to "
        "count each trade once.",
    )
    ticker: str = Field(min_length=1)
    transaction_type: TransactionType
    amount_range: str = Field(
        min_length=1,
        description="Disclosed dollar band, verbatim, e.g. '$1,001 - $15,000'.",
    )
    transaction_date: date
    disclosure_date: date
    filing_type: FilingType | None = Field(
        default=None,
        description="Same vocabulary as the House/Senate pipelines: "
        "'original' | 'amendment' | null. Null only when the source "
        "PTR/pipeline row didn't expose one — never guessed.",
    )

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
    filing_type: str | None = Field(
        default=None,
        description="LDA filing type code, e.g. 'Q2' (quarterly report), "
        "'Q2A' (amendment), 'RR' (registration), 'RA' (registration "
        "amendment).",
    )
    filing_posted_date: date | None = Field(
        default=None, description="Date the filing was posted (LDA dt_posted)."
    )
    amount_reported: float | None = Field(
        default=None,
        ge=0.0,
        description="Reported lobbying spend in USD (income for lobbying "
        "firms, else expenses for self-filers); None if the source is null "
        "— see amount_reported_status for why.",
    )
    amount_reported_status: AmountStatus = Field(
        default=AmountStatus.reported,
        description="'reported' | 'not_applicable_registration' (LD-1 "
        "registrations have no amount fields) | 'not_reported' (report "
        "with null income and expenses at the source).",
    )
    amount_outlier: bool = Field(
        default=False,
        description="True when amount_reported is implausibly large for a "
        "single LD-2 (>= AMOUNT_OUTLIER_THRESHOLD, e.g. filings with "
        "registrant/client strings like 'STATE OF LOC NATION' that look "
        "like data-entry errors in the source). Never dropped or zeroed — "
        "flagged so a downstream spend total can choose to exclude it.",
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

    # What the join is keyed on. ALWAYS "sector": trades are matched to
    # lobbying by crosswalk sector (ticker -> sector, LDA issue code ->
    # sector), never by issuer. A lobbying filing in `lobbying` is NOT
    # about the company whose stock was traded.
    match_level: Literal["sector"] = "sector"

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
    lobbying: list[LobbyingFiling] = Field(
        min_length=1,
        description="Lobbying filings for this (quarter, sector) — sector-"
        "wide, not specific to any one trade or trader. A registrant in "
        "this list is not necessarily connected to the member's trade "
        "beyond sharing a sector and a quarter.",
    )
    sector_lobbying_filing_count: NonNegativeInt = Field(
        description="Total filings matching this (quarter, sector) — sector-"
        "wide, not trade-specific (see `lobbying`). When greater than "
        "len(lobbying), the evidence list was capped to the filings with "
        "the largest reported amounts — truncation is always visible here, "
        "never silent. Named `sector_*` because it is easy to misread as "
        "'filings related to this trade', which it is not.",
    )
    committees: list[CommitteeAssignment] = Field(default_factory=list)

    overlap_type: OverlapType

    is_primary_mapping: bool = Field(
        default=True,
        description="True when at least one trade in this record is at its "
        "primary sector mapping (see Trade.is_primary_mapping). Records "
        "where it is false only exist because a multi-sector ticker also "
        "maps here; drop them to avoid counting those trades twice.",
    )

    disclosure_lag_days: NonNegativeInt | None = Field(
        description="Days from the earliest trade's transaction date to its "
        "disclosure date. Null whenever that trade's filing_type is "
        "'amendment': an amendment can be filed long after the original "
        "PTR for reasons unrelated to disclosure timeliness (e.g. "
        "correcting an amount range), so the gap is not a meaningful lag "
        "and must not be emitted as if it were a late original filing.",
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
        if self.sector_lobbying_filing_count < len(self.lobbying):
            raise ValueError(
                "sector_lobbying_filing_count cannot be smaller than the "
                "evidence list"
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


class RejectedTrackerRun(BaseModel):
    """A newer tracker run that was passed over as unsuitable, and why."""

    model_config = _STRICT

    run_id: str = Field(min_length=1)
    reasons: list[str] = Field(min_length=1)


class TrackerRunInfo(BaseModel):
    """Which tracker run's dataset was consumed for one chamber, with that
    run's own RUN_SUMMARY, so any output can be traced to its exact input."""

    model_config = _STRICT

    run_id: str = Field(min_length=1)
    dataset_id: str = Field(min_length=1)
    finished_at: str | None = None
    run_summary: dict[str, str | int | float | bool | None] = Field(
        default_factory=dict
    )
    warnings: list[str] = Field(default_factory=list)
    rejected_newer_runs: list[RejectedTrackerRun] = Field(default_factory=list)


class RunSummary(BaseModel):
    """Written to the key-value store under RUN_SUMMARY. Describes coverage
    and gaps for one actor run — not part of the dataset itself."""

    model_config = _STRICT

    quarters_covered: list[str] = Field(default_factory=list)
    members_scanned: NonNegativeInt = 0
    overlaps_by_type: dict[OverlapType, NonNegativeInt] = Field(
        default_factory=dict
    )
    low_confidence_excluded: NonNegativeInt = Field(
        default=0,
        description="Overlap records dropped because their strongest "
        "mapping rule was mapping_confidence='low' (e.g. AT&T -> "
        "media_entertainment via a GICS fallback). Excluded from the "
        "dataset by default because they are wrong often enough to be "
        "noise — counted here so the exclusion is visible, not silent.",
    )
    lda_amount_outliers: NonNegativeInt = Field(
        default=0,
        description="LDA filings seen this run with amount_reported >= "
        "AMOUNT_OUTLIER_THRESHOLD, flagged amount_outlier=true on the "
        "record rather than dropped or altered.",
    )
    unmapped: list[UnmappedItem] = Field(default_factory=list)
    source_freshness: list[SourceFreshness] = Field(default_factory=list)
    member_resolution: dict[str, NonNegativeInt] = Field(
        default_factory=dict,
        description="Trades attributed to members, by how: 'bioguide_id' "
        "(tracker-supplied id) or 'name' (display-name fallback). A nonzero "
        "'name' count means some tracker rows lacked a usable id.",
    )
    tracker_runs: dict[str, TrackerRunInfo] = Field(
        default_factory=dict,
        description="Per chamber: the tracker run whose dataset was used "
        "(id, its RUN_SUMMARY) and any newer runs skipped as partial "
        "(truncated, filtered, debug-limited, or window not covering the "
        "quarters). The run fails if no recent run is suitable.",
    )
    ptr_sources: dict[str, dict[str, NonNegativeInt]] = Field(
        default_factory=dict,
        description="Per-chamber tracker intake: rows_read, trades_mapped, "
        "rows_skipped, names_unresolved, trades_in_quarters. Explains "
        "why a chamber contributed few or no records.",
    )
    ptr_skip_reasons: dict[str, NonNegativeInt] = Field(
        default_factory=dict,
        description="Tracker rows the adapter could not map, by reason.",
    )
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
