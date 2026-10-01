"""PTR trade source: adapter over the existing Congress trades actors.

Reads the latest successful run's dataset of
`seralifatih/congress-house-trades` and
`seralifatih/congress-senate-trades` via the Apify API and maps their
rows to `Trade` / `MemberTrade`. The actors themselves are NOT rewritten
or modified (CLAUDE.md: reuse, do not rewrite).

The two actors emit different schemas:

    House (one row per transaction):
        politician, transaction_date, filing_date, ticker, asset_type,
        type, amount_min, amount_max, owner, filing_type, id
    Senate:
        filer_name, trade_type, ticker, asset_type, amount_low,
        amount_high, trade_date, filing_date, owner, is_active,
        filing_type, id

    `filing_type` ('original' | 'amendment' | null, same vocabulary as the
    source pipelines) is read straight through when present — see
    `_filing_type()`. `amendment_number` (Senate-only upstream) has no
    equivalent here; disclosure_lag_days is nulled for amendments instead
    of trying to interpret it (see overlap.py).

Rows are dispatched on which name field is present.

ptr_url: House rows carry `pdf_url`, the filing's own PDF — passed through
(`ptr_url_kind: "document"`). Senate rows have `pdf_url: null` on every
parsed row (only placeholder rows carry one), so Senate trades get the
generic search portal (`ptr_url_kind: "portal_fallback"`). The Senate
source does identify each filing by UUID (`filing_id`, carried as
`ptr_filing_id`) and links its detail pages as /search/view/ptr/<uuid>/,
but efdsearch.senate.gov is session-gated and could not be reached to
confirm that path resolves, so no URL is synthesized from it.
`ptr_filing_id` is the tracker's `filing_id`; the row hash (`id`) is kept
separately as `tracker_row_id`.

Member attribution: trackers emit `member_bioguide_id`; it is used when
present and in the roster. Otherwise the adapter falls back to resolving
the display name and marks the trade `member_resolution: "name"`.
Unresolved rows are reported, never silently dropped.

Standalone use (maps a local JSON dump, no token needed):

    python -m src.sources.ptr --file house_items.json --out mapped.json

Or read live datasets (needs APIFY_TOKEN):

    APIFY_TOKEN=... python -m src.sources.ptr --actor house --out mapped.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import httpx
from pydantic import ValidationError

if __package__:
    from ..models import (
        FilingType,
        MemberResolution,
        PtrUrlKind,
        Trade,
        TransactionType,
    )
    from ..overlap import MemberTrade
    from .legislators import Member
else:  # pragma: no cover - loose-script fallback
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models import (  # type: ignore[no-redefine]
        FilingType,
        MemberResolution,
        PtrUrlKind,
        Trade,
        TransactionType,
    )
    from overlap import MemberTrade  # type: ignore[no-redefine]
    from sources.legislators import Member  # type: ignore[no-redefine]

logger = logging.getLogger(__name__)

APIFY_API = "https://api.apify.com/v2"
TOKEN_ENV = "APIFY_TOKEN"

# Deployed actor slugs (Store titles: "U.S. House Congress Trade Tracker"
# and "U.S. Senate Congress Trade Tracker"). Note the counterintuitive
# naming: `-1` is the HOUSE actor, the bare name is the SENATE actor.
ACTORS: dict[str, str] = {
    "house": "seralifatih~congress-trading-pipeline-1",
    "senate": "seralifatih~congress-trading-pipeline",
}

# ptr_url fallback when the source row has no per-filing URL yet.
FALLBACK_PTR_URL: dict[str, str] = {
    "house": "https://disclosures-clerk.house.gov/FinancialDisclosure",
    "senate": "https://efdsearch.senate.gov/search/",
}

DEFAULT_TIMEOUT = 30.0
MAX_RETRIES = 3
BACKOFF_BASE = 1.0
BACKOFF_CAP = 20.0

# Trackers emit buy/sell/exchange; the long forms are accepted for older
# datasets and raw source labels.
_TX_TYPE_MAP: dict[str, TransactionType] = {
    "buy": TransactionType.buy,
    "purchase": TransactionType.buy,
    "sell": TransactionType.sell,
    "sale": TransactionType.sell,
    "sale_full": TransactionType.sell,
    "sale_partial": TransactionType.sell,
    "sale (full)": TransactionType.sell,
    "sale (partial)": TransactionType.sell,
    "exchange": TransactionType.exchange,
}


class PTRSourceError(RuntimeError):
    """Non-retryable failure reading the trades actors' datasets."""


@dataclass(frozen=True)
class SkippedRow:
    """One source row the adapter could not map, with the reason —
    reported in the run summary, never silently dropped."""

    row_id: str
    reason: str


@dataclass
class AdapterResult:
    member_trades: list[MemberTrade] = field(default_factory=list)
    unresolved_names: list[str] = field(default_factory=list)
    skipped: list[SkippedRow] = field(default_factory=list)
    rows_read: int = 0
    # Display names attributed via the name fallback (no usable bioguide id).
    name_fallback_names: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Name -> bioguide resolution
# ---------------------------------------------------------------------------
def _norm_name(name: str) -> str:
    """Case/accent/punctuation-insensitive name key."""
    ascii_name = (
        unicodedata.normalize("NFKD", name)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    return re.sub(r"[^a-z ]", "", ascii_name.lower()).strip()


_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}

# Common US first-name nicknames -> formal form, applied to the FIRST
# token of the fallback key on both the roster and the input side, so
# "Richard W. Allen" (source) matches "Rick W. Allen" (roster) and vice
# versa. Only unambiguous pairs — nothing that maps two distinct formal
# names onto one key (no "pat", no "chris" -> two names, etc.).
_NICKNAME_TO_FORMAL: dict[str, str] = {
    "abe": "abraham", "al": "albert", "andy": "andrew", "ben": "benjamin",
    "bernie": "bernard", "bill": "william", "billy": "william",
    "bob": "robert", "bobby": "robert", "charlie": "charles",
    "chuck": "charles", "dan": "daniel", "danny": "daniel",
    "dave": "david", "deb": "deborah", "debbie": "deborah",
    "dick": "richard", "don": "donald", "doug": "douglas",
    "ed": "edward", "eddie": "edward", "fred": "frederick",
    "greg": "gregory", "hank": "henry", "jeff": "jeffrey",
    "jerry": "gerald", "jim": "james", "jimmy": "james", "joe": "joseph",
    "joey": "joseph", "jon": "jonathan", "josh": "joshua",
    "kathy": "kathleen", "ken": "kenneth", "larry": "lawrence",
    "liz": "elizabeth", "matt": "matthew", "mike": "michael",
    "nick": "nicholas", "pete": "peter", "ray": "raymond",
    "rich": "richard", "rick": "richard", "ron": "ronald",
    "sam": "samuel", "sandy": "sandra", "steve": "steven",
    "sue": "susan", "ted": "theodore", "tim": "timothy", "tom": "thomas",
    "tommy": "thomas", "tony": "anthony", "vicki": "victoria",
    "will": "william",
}


def _first_last_key(norm: str) -> str:
    """'james e banks jr' -> 'james banks' — fallback key that survives
    middle names/initials, suffixes, and common nickname/formal-name
    variation in the first token."""
    tokens = [t for t in norm.split() if t not in _SUFFIXES]
    if len(tokens) < 2:
        return norm
    first = _NICKNAME_TO_FORMAL.get(tokens[0], tokens[0])
    return f"{first} {tokens[-1]}"


class NameResolver:
    """Resolves source display names to bioguide ids via the Member index.

    Exact normalized-name match first, then first+last fallback. A
    fallback key shared by two members is treated as ambiguous and does
    not resolve.
    """

    def __init__(self, members: dict[str, Member]) -> None:
        self._exact: dict[str, str] = {}
        fallback_ids: dict[str, set[str]] = {}
        for bioguide, member in members.items():
            for display in (member.name, *member.aliases):
                norm = _norm_name(display)
                self._exact.setdefault(norm, bioguide)
                fallback_ids.setdefault(_first_last_key(norm), set()).add(bioguide)
        self._fallback: dict[str, str] = {
            key: next(iter(ids))
            for key, ids in fallback_ids.items()
            if len(ids) == 1
        }
        ambiguous = sorted(k for k, ids in fallback_ids.items() if len(ids) > 1)
        if ambiguous:
            logger.debug("name resolver: %d ambiguous fallback keys", len(ambiguous))

    def resolve(self, display_name: str) -> str | None:
        norm = _norm_name(display_name)
        hit = self._exact.get(norm)
        if hit is not None:
            return hit
        return self._fallback.get(_first_last_key(norm))


# ---------------------------------------------------------------------------
# Row mapping (pure)
# ---------------------------------------------------------------------------
def _amount_range(low: object, high: object) -> str | None:
    """(1001, 15000) -> '$1,001 - $15,000'; (1001, None) -> '$1,001+'."""
    if not isinstance(low, (int, float)):
        return None
    if isinstance(high, (int, float)):
        return f"${int(low):,} - ${int(high):,}"
    return f"${int(low):,}+"


def _parse_date(raw: object) -> date | None:
    if not isinstance(raw, str):
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def _filing_type(raw: object) -> FilingType | None:
    """Source rows carry 'original' | 'amendment' | null (same vocabulary
    the House/Senate pipelines use) — pass through, never guess. null
    means the tracker's source row didn't state a filing status."""
    value = raw.strip().lower() if isinstance(raw, str) else raw
    if value == "original":
        return FilingType.original
    if value == "amendment":
        return FilingType.amendment
    return None


def _row_chamber(row: dict) -> str | None:
    if "politician" in row:
        return "house"
    if "filer_name" in row:
        return "senate"
    return None


def map_row(row: dict) -> tuple[str, str | None, Trade] | SkippedRow:
    """Map one source row to (display_name, tracker_bioguide_id, Trade), or
    a SkippedRow with the reason. Pure — no I/O."""
    row_id = str(row.get("id", "<no id>"))

    chamber = _row_chamber(row)
    if chamber is None:
        return SkippedRow(row_id, "unrecognized row shape")

    if chamber == "house":
        name = row["politician"]
        tx_date = _parse_date(row.get("transaction_date"))
        raw_type = row.get("type")
        amount = _amount_range(row.get("amount_min"), row.get("amount_max"))
    else:
        if row.get("is_active") is False:
            return SkippedRow(row_id, "inactive (superseded/amended) row")
        name = row["filer_name"]
        tx_date = _parse_date(row.get("trade_date"))
        raw_type = row.get("trade_type")
        amount = _amount_range(row.get("amount_low"), row.get("amount_high"))

    disclosure = _parse_date(row.get("filing_date"))
    ticker_raw = row.get("ticker")
    ticker = str(ticker_raw).strip().upper() if ticker_raw else ""
    if not ticker or ticker in ("--", "N/A", "NONE"):
        return SkippedRow(row_id, "no ticker (non-listed asset)")

    tx_type = _TX_TYPE_MAP.get(str(raw_type).strip().lower())
    if tx_type is None:
        return SkippedRow(row_id, f"unknown transaction type {raw_type!r}")
    if tx_date is None or disclosure is None:
        return SkippedRow(row_id, "missing/unparseable dates")
    if amount is None:
        return SkippedRow(row_id, "missing amount range")

    doc_url = row.get("pdf_url") or row.get("ptr_url") or row.get("filing_url")
    ptr_url = str(doc_url) if doc_url else FALLBACK_PTR_URL[chamber]
    ptr_url_kind = PtrUrlKind.document if doc_url else PtrUrlKind.portal_fallback
    filing_id = row.get("filing_id")
    bioguide_raw = row.get("member_bioguide_id")
    bioguide_in_row = (
        bioguide_raw.strip()
        if isinstance(bioguide_raw, str) and bioguide_raw.strip()
        else None
    )

    try:
        trade = Trade(
            ptr_filing_id=str(filing_id) if filing_id else row_id,
            tracker_row_id=row_id,
            ptr_url=ptr_url,
            ptr_url_kind=ptr_url_kind,
            ticker=ticker,
            transaction_type=tx_type,
            amount_range=amount,
            transaction_date=tx_date,
            disclosure_date=disclosure,
            filing_type=_filing_type(row.get("filing_type")),
        )
    except ValidationError as exc:
        # e.g. disclosure before transaction — bad source data.
        return SkippedRow(row_id, f"validation: {exc.errors()[0]['msg']}")
    return str(name), bioguide_in_row, trade


def _flatten_items(items: list[dict]) -> list[dict]:
    """Some exports wrap rows as {count, data: [...]}. Flatten those."""
    flat: list[dict] = []
    for item in items:
        if isinstance(item.get("data"), list):
            flat.extend(d for d in item["data"] if isinstance(d, dict))
        else:
            flat.append(item)
    return flat


def adapt_rows(items: list[dict], members: dict[str, Member]) -> AdapterResult:
    """Map raw dataset items to MemberTrades. Pure — no I/O.

    Unresolved names and unmappable rows are returned, not dropped.
    """
    resolver = NameResolver(members)
    result = AdapterResult()
    unresolved: set[str] = set()
    fallback_names: set[str] = set()

    fallback_urls = set(FALLBACK_PTR_URL.values())
    for row in _flatten_items(items):
        result.rows_read += 1
        mapped = map_row(row)
        if isinstance(mapped, SkippedRow):
            result.skipped.append(mapped)
            continue
        name, row_bioguide, trade = mapped
        # Prefer the tracker's bioguide id; fall back to the display name
        # (also when the id is absent from the current-member roster).
        if row_bioguide is not None and row_bioguide in members:
            bioguide = row_bioguide
            resolution = MemberResolution.bioguide_id
        else:
            resolved = resolver.resolve(name)
            if resolved is None:
                unresolved.add(name)
                continue
            bioguide = resolved
            resolution = MemberResolution.name
            fallback_names.add(name)
        # The fallback portal URL is chosen from the ROW shape, but both
        # tracker actors emit the same row shape for members of either
        # chamber. Once the member is resolved we know the real chamber —
        # point the fallback at the right disclosure portal. Row-provided
        # document URLs are never touched.
        member = members[bioguide]
        expected = FALLBACK_PTR_URL[member.chamber.value]
        updates: dict[str, object] = {"member_resolution": resolution}
        if trade.ptr_url in fallback_urls and trade.ptr_url != expected:
            updates["ptr_url"] = expected
        trade = trade.model_copy(update=updates)
        result.member_trades.append(MemberTrade(bioguide, trade))

    result.unresolved_names = sorted(unresolved)
    result.name_fallback_names = sorted(fallback_names)
    logger.info(
        "ptr adapter: %d rows, %d trades mapped, %d skipped, %d names "
        "unresolved, %d names attributed by name fallback",
        result.rows_read, len(result.member_trades), len(result.skipped),
        len(result.unresolved_names), len(result.name_fallback_names),
    )
    for fb_name in result.name_fallback_names:
        logger.info("ptr adapter: name fallback used for %r", fb_name)
    for skipped_row in result.skipped:
        logger.debug("ptr adapter skipped %s: %s", skipped_row.row_id, skipped_row.reason)
    return result


# ---------------------------------------------------------------------------
# Apify API reading
# ---------------------------------------------------------------------------
async def _api_get(client: httpx.AsyncClient, url: str, params: dict) -> httpx.Response:
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = await client.get(url, params=params)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_exc = exc
            delay = random.uniform(0, min(BACKOFF_CAP, BACKOFF_BASE * 2**attempt))
            logger.warning(
                "apify api error (%s) on %s, retry in %.1fs",
                type(exc).__name__, url, delay,
            )
            await asyncio.sleep(delay)
            continue
        if response.status_code == 429 or response.status_code >= 500:
            if attempt == MAX_RETRIES:
                raise PTRSourceError(
                    f"apify api {response.status_code} on {url} after retries"
                )
            delay = random.uniform(0, min(BACKOFF_CAP, BACKOFF_BASE * 2**attempt))
            await asyncio.sleep(delay)
            continue
        if response.status_code >= 400:
            raise PTRSourceError(
                f"apify api {response.status_code} on {url}: {response.text[:200]}"
            )
        return response
    raise PTRSourceError(f"apify api failed after retries: {last_exc}")


# A tracker run is only a trustworthy input if it was a full, unfiltered
# pull of the window being asked about. Anything else (a members-filtered
# test run, a truncated run, a debug-limited run, a window that misses the
# quarter) silently yields a dataset that LOOKS fine but is partial — the
# overlap would then report "no overlaps" for the wrong reason.
MAX_RUN_CANDIDATES = 15
# A trade made on the last day of a quarter can be filed up to ~45 days
# later; a tracker window ending sooner than that may miss late filings.
LATE_FILING_GRACE_DAYS = 45

_FILTER_COUNTERS = (
    "skippedByMemberCount",
    "filteredByTickerCount",
    "skippedByTransactionDateCount",
    "filteredByTransactionDateCount",
    "placeholdersWithheld",
    "placeholdersExcludedCount",
)
_FILTER_INPUTS = ("members", "tickers", "transactionDateFrom", "transactionDateTo")

ScalarMap = dict[str, str | int | float | bool | None]


def _quarter_bounds(quarter: str) -> tuple[date, date]:
    """'2026-Q2' -> (2026-04-01, 2026-06-30)."""
    year, q = int(quarter[:4]), int(quarter[-1])
    start = date(year, 3 * (q - 1) + 1, 1)
    end = (
        date(year + 1, 1, 1) if q == 4 else date(year, 3 * q + 1, 1)
    ) - timedelta(days=1)
    return start, end


@dataclass(frozen=True)
class RunVerdict:
    """Outcome of assessing one tracker run. Empty `reasons` = suitable."""

    reasons: list[str]
    warnings: list[str]


@dataclass(frozen=True)
class TrackerRun:
    """The tracker run whose dataset was consumed, kept for provenance."""

    chamber: str
    run_id: str
    dataset_id: str
    finished_at: str | None
    run_summary: ScalarMap
    warnings: list[str]
    # (run_id, reasons) for every newer run that was passed over.
    rejected: list[tuple[str, list[str]]]


def _scalars(record: object) -> ScalarMap:
    if not isinstance(record, dict):
        return {}
    return {
        str(k): v
        for k, v in record.items()
        if v is None or isinstance(v, (str, int, float, bool))
    }


def assess_run(
    run_summary: object, run_input: object, quarters: list[str]
) -> RunVerdict:
    """Decide whether a tracker run's dataset can stand in for a full pull
    of `quarters`. Pure — takes the run's RUN_SUMMARY and INPUT records.

    Rejects: no RUN_SUMMARY (pre-1.5 tracker, cannot verify); truncated;
    any filter applied (counters or input); debug-limited; a filing-date
    window that does not cover the quarters. Warns (does not reject) when
    the window ends before late filings for the last quarter could exist.
    """
    reasons: list[str] = []
    warnings: list[str] = []

    if not isinstance(run_summary, dict):
        return RunVerdict(["no RUN_SUMMARY record (cannot verify completeness)"], [])

    if run_summary.get("truncated") is True:
        reasons.append(
            f"truncated ({run_summary.get('reason') or 'max_total_charge_reached'}; "
            f"{run_summary.get('rowsNotEmitted')} rows not written)"
        )
    for key in _FILTER_COUNTERS:
        value = run_summary.get(key)
        if isinstance(value, (int, float)) and value > 0:
            reasons.append(f"filter applied: {key}={value}")

    inp = run_input if isinstance(run_input, dict) else {}
    for key in _FILTER_INPUTS:
        value = inp.get(key)
        if value:  # non-empty list / non-empty string
            reasons.append(f"filter in run input: {key}={value!r}")
    limit = inp.get("debugPtrLimit")
    if isinstance(limit, (int, float)) and limit > 0:
        reasons.append(f"debugPtrLimit={limit} in run input")

    window_from = _parse_date(run_summary.get("windowFrom"))
    window_to = _parse_date(run_summary.get("windowTo"))
    if window_from is None or window_to is None:
        reasons.append("RUN_SUMMARY has no windowFrom/windowTo")
    else:
        bounds = [_quarter_bounds(q) for q in quarters]
        need_from = min(s for s, _ in bounds)
        need_to = max(e for _, e in bounds)
        if window_from > need_from or window_to < need_to:
            reasons.append(
                f"filing-date window {window_from}..{window_to} does not cover "
                f"{need_from}..{need_to}"
            )
        elif window_to < need_to + timedelta(days=LATE_FILING_GRACE_DAYS):
            warnings.append(
                f"window ends {window_to}, less than {LATE_FILING_GRACE_DAYS} "
                f"days after {need_to}: late filings may be missing"
            )
    return RunVerdict(reasons, warnings)


async def _api_get_optional(
    client: httpx.AsyncClient, url: str, params: dict
) -> httpx.Response | None:
    """Like _api_get, but a 404 is an answer (record absent), not an error."""
    try:
        return await _api_get(client, url, params)
    except PTRSourceError as exc:
        if " 404 " in str(exc):
            return None
        raise


async def fetch_tracker_items(
    chamber: str,
    quarters: list[str],
    *,
    token: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> tuple[list[dict], TrackerRun]:
    """Read the dataset of the most recent SUITABLE successful run of the
    chamber's tracker actor.

    Walks back through recent successful runs, skipping any that are
    partial (see `assess_run`). Raises PTRSourceError — failing the run
    loudly — if none of the most recent MAX_RUN_CANDIDATES is suitable.
    """
    if chamber not in ACTORS:
        raise PTRSourceError(f"unknown chamber {chamber!r}; expected house/senate")
    token = token or os.environ.get(TOKEN_ENV)
    if not token:
        raise PTRSourceError(f"{TOKEN_ENV} not set; needed to read actor datasets")

    params = {"token": token}
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout), follow_redirects=True
    ) as client:
        runs_resp = await _api_get(
            client,
            f"{APIFY_API}/acts/{ACTORS[chamber]}/runs",
            {**params, "status": "SUCCEEDED", "desc": 1, "limit": MAX_RUN_CANDIDATES},
        )
        candidates = (runs_resp.json().get("data") or {}).get("items") or []

        async def record(kv_id: str, key: str) -> object:
            resp = await _api_get_optional(
                client, f"{APIFY_API}/key-value-stores/{kv_id}/records/{key}", params
            )
            if resp is None:
                return None
            try:
                return resp.json()
            except ValueError:
                return None

        rejected: list[tuple[str, list[str]]] = []
        chosen: dict | None = None
        chosen_summary: object = None
        verdict = RunVerdict([], [])
        for run in candidates:
            run_id = str(run.get("id"))
            kv_id = run.get("defaultKeyValueStoreId")
            if not kv_id or not run.get("defaultDatasetId"):
                rejected.append((run_id, ["run has no default dataset/store"]))
                continue
            summary = await record(kv_id, "RUN_SUMMARY")
            run_input = await record(kv_id, "INPUT")
            verdict = assess_run(summary, run_input, quarters)
            if verdict.reasons:
                logger.warning(
                    "%s run %s skipped: %s", chamber, run_id, "; ".join(verdict.reasons)
                )
                rejected.append((run_id, verdict.reasons))
                continue
            chosen, chosen_summary = run, summary
            break

        if chosen is None:
            detail = (
                "; ".join(f"{rid}: {', '.join(r)}" for rid, r in rejected)
                or "no successful runs"
            )
            raise PTRSourceError(
                f"{ACTORS[chamber]}: no suitable tracker run for {quarters} among "
                f"the {len(candidates)} most recent successful runs ({detail}). "
                f"Run the tracker unfiltered over the quarter(s) first."
            )
        for warning in verdict.warnings:
            logger.warning("%s run %s: %s", chamber, chosen["id"], warning)

        dataset_id = chosen["defaultDatasetId"]
        items: list[dict] = []
        offset, limit = 0, 1000
        while True:
            page = await _api_get(
                client,
                f"{APIFY_API}/datasets/{dataset_id}/items",
                {**params, "offset": offset, "limit": limit, "format": "json"},
            )
            batch = page.json()
            if not isinstance(batch, list):
                raise PTRSourceError("unexpected dataset items payload")
            items.extend(batch)
            if len(batch) < limit:
                break
            offset += limit
        logger.info(
            "%s: using run %s (%d dataset items, %d newer run(s) skipped)",
            ACTORS[chamber], chosen["id"], len(items), len(rejected),
        )
        return items, TrackerRun(
            chamber=chamber,
            run_id=str(chosen["id"]),
            dataset_id=str(dataset_id),
            finished_at=chosen.get("finishedAt"),
            run_summary=_scalars(chosen_summary),
            warnings=list(verdict.warnings),
            rejected=rejected,
        )


async def fetch_member_trades(
    members: dict[str, Member],
    quarters: list[str],
    chambers: list[str] | None = None,
    *,
    token: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> AdapterResult:
    """One-call API: read the suitable tracker run per chamber, adapt."""
    chambers = chambers or list(ACTORS)
    combined = AdapterResult()
    for chamber in chambers:
        items, _run = await fetch_tracker_items(
            chamber, quarters, token=token, timeout=timeout
        )
        partial = adapt_rows(items, members)
        combined.member_trades.extend(partial.member_trades)
        combined.skipped.extend(partial.skipped)
        combined.unresolved_names.extend(partial.unresolved_names)
        combined.name_fallback_names.extend(partial.name_fallback_names)
        combined.rows_read += partial.rows_read
    combined.unresolved_names = sorted(set(combined.unresolved_names))
    combined.name_fallback_names = sorted(set(combined.name_fallback_names))
    return combined


# ---------------------------------------------------------------------------
# Standalone CLI
# ---------------------------------------------------------------------------
async def _main_async(args: argparse.Namespace) -> int:
    if __package__:
        from .legislators import LocalFileStore, load_members
    else:  # pragma: no cover
        from sources.legislators import (  # type: ignore[no-redefine]
            LocalFileStore,
            load_members,
        )

    store = LocalFileStore(Path(args.cache_dir))
    members, _ = await load_members(store)

    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            items = json.load(fh)
        if not isinstance(items, list):
            items = [items]
        result = adapt_rows(items, members)
    else:
        result = await fetch_member_trades(members, args.quarters, [args.actor])

    payload = {
        "member_trades": [
            {"bioguide_id": mt.bioguide_id, **mt.trade.model_dump(mode="json")}
            for mt in result.member_trades
        ],
        "unresolved_names": result.unresolved_names,
        "skipped": [
            {"row_id": s.row_id, "reason": s.reason} for s in result.skipped
        ],
    }
    out_text = json.dumps(payload, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out_text)
        print(
            f"Wrote {len(result.member_trades)} trades "
            f"({len(result.skipped)} skipped, "
            f"{len(result.unresolved_names)} unresolved names) to {args.out}",
            file=sys.stderr,
        )
    else:
        print(out_text)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Adapt Congress trades actor output to Trade records."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file", help="Local JSON dump of dataset items")
    source.add_argument(
        "--actor", choices=list(ACTORS), help="Read live via Apify API"
    )
    parser.add_argument("--out", help="Write JSON here instead of stdout")
    parser.add_argument(
        "--quarters", nargs="+", default=[],
        help="Quarters the tracker run must cover, e.g. 2026-Q2 (--actor only)",
    )
    parser.add_argument(
        "--cache-dir",
        default=str(Path(__file__).resolve().parents[2] / ".cache"),
        dest="cache_dir",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        return asyncio.run(_main_async(args))
    except PTRSourceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
