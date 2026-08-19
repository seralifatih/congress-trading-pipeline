"""PTR trade source: adapter over the existing Congress trades actors.

Reads the latest successful run's dataset of
`seralifatih/congress-house-trades` and
`seralifatih/congress-senate-trades` via the Apify API and maps their
rows to `Trade` / `MemberTrade`. The actors themselves are NOT rewritten
or modified (CLAUDE.md: reuse, do not rewrite).

The two actors emit different schemas:

    House (one row per transaction):
        politician, transaction_date, filing_date, ticker, asset_type,
        type, amount_min, amount_max, owner, id
    Senate:
        filer_name, trade_type, ticker, asset_type, amount_low,
        amount_high, trade_date, filing_date, owner, is_active, id

Rows are dispatched on which name field is present.

ptr_url: neither schema carries a per-filing URL today. The adapter uses
a `ptr_url` / `filing_url` field when the source actors start emitting
one, and falls back to the official disclosure search portal for the
chamber. Upgrading the actors later improves traceability without
breaking this adapter.

Member attribution: source rows carry display names, not bioguide ids.
The adapter resolves names against the legislators index; unresolved
names are reported, never silently dropped.

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
from datetime import date
from pathlib import Path

import httpx
from pydantic import ValidationError

if __package__:
    from ..models import Trade, TransactionType
    from ..overlap import MemberTrade
    from .legislators import Member
else:  # pragma: no cover - loose-script fallback
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models import Trade, TransactionType  # type: ignore[no-redefine]
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

_TX_TYPE_MAP: dict[str, TransactionType] = {
    "purchase": TransactionType.purchase,
    "buy": TransactionType.purchase,
    "sell": TransactionType.sale,
    "sale": TransactionType.sale,
    "sale_full": TransactionType.sale,
    "sale_partial": TransactionType.sale,
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


def _row_chamber(row: dict) -> str | None:
    if "politician" in row:
        return "house"
    if "filer_name" in row:
        return "senate"
    return None


def map_row(row: dict) -> tuple[str, Trade] | SkippedRow:
    """Map one source row to (display_name, Trade), or a SkippedRow with
    the reason. Pure — no I/O."""
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

    ptr_url = (
        row.get("ptr_url")
        or row.get("filing_url")
        or FALLBACK_PTR_URL[chamber]
    )

    try:
        trade = Trade(
            ptr_filing_id=row_id,
            ptr_url=str(ptr_url),
            ticker=ticker,
            transaction_type=tx_type,
            amount_range=amount,
            transaction_date=tx_date,
            disclosure_date=disclosure,
        )
    except ValidationError as exc:
        # e.g. disclosure before transaction — bad source data.
        return SkippedRow(row_id, f"validation: {exc.errors()[0]['msg']}")
    return str(name), trade


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

    fallback_urls = set(FALLBACK_PTR_URL.values())
    for row in _flatten_items(items):
        mapped = map_row(row)
        if isinstance(mapped, SkippedRow):
            result.skipped.append(mapped)
            continue
        name, trade = mapped
        bioguide = resolver.resolve(name)
        if bioguide is None:
            unresolved.add(name)
            continue
        # The fallback ptr_url is chosen from the ROW shape, but both
        # source actors emit house-shaped rows for members of either
        # chamber. Once the member is resolved we know the real chamber —
        # point the fallback at the right disclosure portal. Row-provided
        # URLs are never touched.
        member = members[bioguide]
        expected = FALLBACK_PTR_URL[member.chamber.value]
        if trade.ptr_url in fallback_urls and trade.ptr_url != expected:
            trade = trade.model_copy(update={"ptr_url": expected})
        result.member_trades.append(MemberTrade(bioguide, trade))

    result.unresolved_names = sorted(unresolved)
    logger.info(
        "ptr adapter: %d trades mapped, %d rows skipped, %d names unresolved",
        len(result.member_trades), len(result.skipped), len(result.unresolved_names),
    )
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


async def fetch_latest_items(
    chamber: str,
    *,
    token: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> list[dict]:
    """Read all dataset items of the latest successful run of the given
    chamber's trades actor."""
    if chamber not in ACTORS:
        raise PTRSourceError(f"unknown chamber {chamber!r}; expected house/senate")
    token = token or os.environ.get(TOKEN_ENV)
    if not token:
        raise PTRSourceError(f"{TOKEN_ENV} not set; needed to read actor datasets")

    params = {"token": token}
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout), follow_redirects=True
    ) as client:
        run_url = f"{APIFY_API}/acts/{ACTORS[chamber]}/runs/last"
        logger.info("Fetching last successful run of %s", ACTORS[chamber])
        run_resp = await _api_get(
            client, run_url, {**params, "status": "SUCCEEDED"}
        )
        run_data = run_resp.json().get("data") or {}
        dataset_id = run_data.get("defaultDatasetId")
        if not dataset_id:
            raise PTRSourceError(
                f"{ACTORS[chamber]}: no successful run with a dataset found"
            )

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
        logger.info("%s: %d dataset items", ACTORS[chamber], len(items))
        return items


async def fetch_member_trades(
    members: dict[str, Member],
    chambers: list[str] | None = None,
    *,
    token: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> AdapterResult:
    """One-call API for main.py: read both actors, adapt everything."""
    chambers = chambers or list(ACTORS)
    combined = AdapterResult()
    for chamber in chambers:
        items = await fetch_latest_items(chamber, token=token, timeout=timeout)
        partial = adapt_rows(items, members)
        combined.member_trades.extend(partial.member_trades)
        combined.skipped.extend(partial.skipped)
        combined.unresolved_names.extend(partial.unresolved_names)
    combined.unresolved_names = sorted(set(combined.unresolved_names))
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
        result = await fetch_member_trades(members, [args.actor])

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
