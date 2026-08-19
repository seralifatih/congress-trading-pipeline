"""Member roster + committee membership from unitedstates/congress-legislators.

Fetches three JSON files from the unitedstates project's GitHub Pages
mirror, joins them into a bioguide-indexed member map, and attaches
jurisdiction tags from data/committee_jurisdictions.yaml.

Caching: the three raw upstream files are cached as one record in the
Apify key-value store (or a local file store when run standalone) with a
30-day TTL. We cache raw files, not the built index, so edits to the
jurisdiction YAML take effect without a refetch. The data changes
per-Congress, not per-run — see CLAUDE.md.

Standalone use — build the index and write it to JSON for inspection:

    python -m src.sources.legislators --out members.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

import httpx
import yaml
from pydantic import BaseModel, ConfigDict, Field

# Support both `python -m src.sources.legislators` (package) and loose script.
if __package__:
    from ..models import Chamber, CommitteeAssignment, Party
else:  # pragma: no cover
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models import Chamber, CommitteeAssignment, Party  # type: ignore[no-redefine]

logger = logging.getLogger(__name__)

BASE_URL = "https://unitedstates.github.io/congress-legislators/"
FILES: dict[str, str] = {
    "legislators": "legislators-current.json",
    "committees": "committees-current.json",
    "membership": "committee-membership-current.json",
}

CACHE_KEY = "LEGISLATORS_RAW"
CACHE_TTL = timedelta(days=30)

DEFAULT_TIMEOUT = 60.0  # files are large (legislators-current ~10 MB)
MAX_RETRIES = 3
BACKOFF_BASE = 1.0
BACKOFF_CAP = 20.0

# Repo root: src/sources/legislators.py -> parents[2]
_REPO_ROOT = Path(__file__).resolve().parents[2]
JURISDICTIONS_PATH = _REPO_ROOT / "data" / "committee_jurisdictions.yaml"

UNMAPPED_TAG = "unmapped"

_PARTY_MAP: dict[str, Party] = {
    "Democrat": Party.democrat,
    "Republican": Party.republican,
    "Independent": Party.independent,
}


class LegislatorsError(RuntimeError):
    """Non-retryable failure fetching or building the member index."""


class Member(BaseModel):
    """One current member with their committee assignments."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    bioguide_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    chamber: Chamber
    party: Party
    state: str = Field(min_length=2, max_length=2)
    committees: list[CommitteeAssignment] = Field(default_factory=list)
    aliases: list[str] = Field(
        default_factory=list,
        description="Alternate display names ('first last', 'nickname last') "
        "for source-name resolution. Not part of the output contract.",
    )


class KVStore(Protocol):
    """Minimal key-value store interface. Apify's KeyValueStore satisfies
    it; `LocalFileStore` below is the standalone fallback."""

    async def get_value(self, key: str) -> object: ...

    async def set_value(self, key: str, value: object) -> None: ...


class LocalFileStore:
    """File-backed KVStore for standalone runs. One JSON file per key."""

    def __init__(self, root: Path) -> None:
        self._root = root

    def _path(self, key: str) -> Path:
        return self._root / f"{key}.json"

    async def get_value(self, key: str) -> object:
        path = self._path(key)
        if not path.exists():
            return None
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)

    async def set_value(self, key: str, value: object) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        with self._path(key).open("w", encoding="utf-8") as fh:
            json.dump(value, fh, ensure_ascii=False)


# --------------------------------------------------------------------------
# Fetching + caching
# --------------------------------------------------------------------------
async def _get_json(client: httpx.AsyncClient, url: str) -> object:
    """GET one JSON file with retry + backoff. 4xx is fatal (these are
    static files; a 404 means the upstream layout changed)."""
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = await client.get(url)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_exc = exc
            delay = random.uniform(0, min(BACKOFF_CAP, BACKOFF_BASE * 2**attempt))
            logger.warning(
                "legislators fetch error (%s) on %s, attempt %d/%d, retry in %.1fs",
                type(exc).__name__, url, attempt + 1, MAX_RETRIES + 1, delay,
            )
            await asyncio.sleep(delay)
            continue

        if response.status_code >= 500:
            if attempt == MAX_RETRIES:
                raise LegislatorsError(
                    f"{url} returned {response.status_code} after retries"
                )
            delay = random.uniform(0, min(BACKOFF_CAP, BACKOFF_BASE * 2**attempt))
            logger.warning(
                "legislators %d on %s, retry in %.1fs",
                response.status_code, url, delay,
            )
            await asyncio.sleep(delay)
            continue

        if response.status_code >= 400:
            raise LegislatorsError(f"{url} returned {response.status_code}")

        return response.json()

    raise LegislatorsError(f"fetch failed after retries: {last_exc}")


def _cache_fresh(record: object) -> bool:
    if not isinstance(record, dict):
        return False
    fetched_at = record.get("fetched_at")
    if not isinstance(fetched_at, str):
        return False
    try:
        stamp = datetime.fromisoformat(fetched_at)
    except ValueError:
        return False
    return datetime.now(timezone.utc) - stamp < CACHE_TTL


async def load_raw(
    store: KVStore | None = None,
    *,
    refresh: bool = False,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, object]:
    """Return {'legislators': [...], 'committees': [...], 'membership': {...}}.

    Serves from `store` when the cached record is younger than 30 days;
    otherwise fetches all three files concurrently and re-caches.
    """
    if store is not None and not refresh:
        cached = await store.get_value(CACHE_KEY)
        if _cache_fresh(cached):
            assert isinstance(cached, dict)
            logger.info(
                "legislators: cache hit (fetched_at=%s)", cached["fetched_at"]
            )
            return {name: cached[name] for name in FILES}
        logger.info("legislators: cache stale or missing, refetching")

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout), follow_redirects=True
    ) as client:
        logger.info("Fetching %d files from %s", len(FILES), BASE_URL)
        results = await asyncio.gather(
            *(_get_json(client, BASE_URL + fname) for fname in FILES.values())
        )
    raw = dict(zip(FILES, results))

    if store is not None:
        await store.set_value(
            CACHE_KEY,
            {"fetched_at": datetime.now(timezone.utc).isoformat(), **raw},
        )
        logger.info("legislators: cached under %s (TTL %d days)",
                    CACHE_KEY, CACHE_TTL.days)
    return raw


# --------------------------------------------------------------------------
# Jurisdiction tags
# --------------------------------------------------------------------------
def load_jurisdictions(path: Path = JURISDICTIONS_PATH) -> dict[str, list[str]]:
    """committee thomas_id -> sector tags, from the hand-edited YAML."""
    with path.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    committees = doc.get("committees") if isinstance(doc, dict) else None
    if not isinstance(committees, dict):
        raise LegislatorsError(f"{path} has no 'committees' mapping")
    out: dict[str, list[str]] = {}
    for cid, entry in committees.items():
        sectors = entry.get("sectors") if isinstance(entry, dict) else None
        if not sectors:
            logger.warning("jurisdictions: %s has no sectors, skipping", cid)
            continue
        out[str(cid)] = [str(s) for s in sectors]
    return out


def _tags_for(
    committee_id: str,
    jurisdictions: dict[str, list[str]],
    unmapped: set[str],
) -> list[str]:
    """Tags for a committee id; subcommittees (HSAS28) inherit the parent
    (HSAS). Unknown committees get UNMAPPED_TAG and are reported."""
    if committee_id in jurisdictions:
        return jurisdictions[committee_id]
    parent = committee_id[:4]
    if parent in jurisdictions:
        return jurisdictions[parent]
    unmapped.add(committee_id)
    return [UNMAPPED_TAG]


# --------------------------------------------------------------------------
# Index building
# --------------------------------------------------------------------------
def build_index(
    raw: dict[str, object],
    jurisdictions: dict[str, list[str]],
) -> tuple[dict[str, Member], set[str]]:
    """Join the three files into bioguide_id -> Member.

    Returns (index, unmapped_committee_ids). Unmapped committees are
    tagged `unmapped`, never dropped.
    """
    legislators = raw["legislators"]
    committees = raw["committees"]
    membership = raw["membership"]
    if not isinstance(legislators, list) or not isinstance(committees, list) \
            or not isinstance(membership, dict):
        raise LegislatorsError("unexpected upstream file shapes")

    # committee thomas_id -> display name (parents and subcommittees)
    committee_names: dict[str, str] = {}
    for com in committees:
        cid = com.get("thomas_id")
        if not cid:
            continue
        committee_names[cid] = com.get("name", cid)
        for sub in com.get("subcommittees") or []:
            sub_id = f"{cid}{sub.get('thomas_id', '')}"
            committee_names[sub_id] = (
                f"{com.get('name', cid)}: {sub.get('name', sub_id)}"
            )

    # Pass 1 — members without committees.
    plain: dict[str, dict[str, object]] = {}
    for leg in legislators:
        ids = leg.get("id") or {}
        bioguide = ids.get("bioguide")
        terms = leg.get("terms") or []
        if not bioguide or not terms:
            logger.debug("skipping legislator without bioguide/terms: %r", ids)
            continue
        term = terms[-1]
        term_type = term.get("type")
        if term_type not in ("rep", "sen"):
            logger.debug("skipping %s: unknown term type %r", bioguide, term_type)
            continue
        party_raw = str(term.get("party", ""))
        party = _PARTY_MAP.get(party_raw)
        if party is None:
            logger.warning(
                "member %s has party %r, mapping to Independent",
                bioguide, party_raw,
            )
            party = Party.independent
        name = leg.get("name") or {}
        full_name = name.get("official_full") or (
            f"{name.get('first', '')} {name.get('last', '')}".strip()
        )
        # Alternate display forms — PTR sources publish e.g. formal first
        # names where the roster uses a nickname (and vice versa).
        alias_set: set[str] = set()
        first, last, nick = name.get("first"), name.get("last"), name.get("nickname")
        if first and last:
            alias_set.add(f"{first} {last}")
        if nick and last:
            alias_set.add(f"{nick} {last}")
        alias_set.discard(full_name)
        plain[bioguide] = {
            "bioguide_id": bioguide,
            "name": full_name,
            "chamber": Chamber.house if term_type == "rep" else Chamber.senate,
            "party": party,
            "state": str(term.get("state", "")),
            "committees": [],
            "aliases": sorted(alias_set),
        }

    # Pass 2 — attach committee assignments.
    unmapped: set[str] = set()
    for cid, roster in membership.items():
        if not isinstance(roster, list):
            continue
        tags = _tags_for(cid, jurisdictions, unmapped)
        cname = committee_names.get(cid, cid)
        is_sub = len(cid) > 4
        for entry in roster:
            bioguide = entry.get("bioguide")
            if not bioguide or bioguide not in plain:
                logger.debug("membership %s: unknown bioguide %r", cid, bioguide)
                continue
            assignment = CommitteeAssignment(
                committee_id=cid,
                committee_name=cname,
                jurisdiction_tags=tags,
                is_subcommittee=is_sub,
                role=entry.get("title"),
            )
            plain[bioguide]["committees"].append(assignment)  # type: ignore[union-attr]

    index = {bid: Member(**data) for bid, data in plain.items()}  # type: ignore[arg-type]
    if unmapped:
        logger.warning(
            "jurisdictions: %d committee ids unmapped: %s",
            len(unmapped), ", ".join(sorted(unmapped)),
        )
    return index, unmapped


async def load_members(
    store: KVStore | None = None,
    *,
    refresh: bool = False,
    jurisdictions_path: Path = JURISDICTIONS_PATH,
    timeout: float = DEFAULT_TIMEOUT,
) -> tuple[dict[str, Member], set[str]]:
    """One-call API: fetch (or cache-hit) raw files, build the index.

    Returns (bioguide_id -> Member, unmapped committee ids for the run
    summary)."""
    raw = await load_raw(store, refresh=refresh, timeout=timeout)
    jurisdictions = load_jurisdictions(jurisdictions_path)
    index, unmapped = build_index(raw, jurisdictions)
    logger.info(
        "legislators: %d members indexed, %d committees unmapped",
        len(index), len(unmapped),
    )
    return index, unmapped


# --------------------------------------------------------------------------
# Standalone CLI
# --------------------------------------------------------------------------
async def _main_async(args: argparse.Namespace) -> int:
    store: KVStore | None = None
    if not args.no_cache:
        store = LocalFileStore(Path(args.cache_dir))
    index, unmapped = await load_members(store, refresh=args.refresh)

    payload = {
        "members": {bid: m.model_dump(mode="json") for bid, m in index.items()},
        "unmapped_committees": sorted(unmapped),
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        print(f"Wrote {len(index)} members to {args.out}", file=sys.stderr)
    else:
        json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
        print()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the member/committee index from congress-legislators."
    )
    parser.add_argument("--out", help="Write JSON here instead of stdout")
    parser.add_argument(
        "--cache-dir", default=str(_REPO_ROOT / ".cache"), dest="cache_dir"
    )
    parser.add_argument(
        "--no-cache", action="store_true", help="Skip the local file cache"
    )
    parser.add_argument(
        "--refresh", action="store_true", help="Ignore cache, force refetch"
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        return asyncio.run(_main_async(args))
    except LegislatorsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
