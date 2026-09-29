# U.S. Senate Trading Pipeline

A senator files a $250k purchase of defense stock the week before a
major procurement vote. The filing lands quietly on the Senate EFD
system.

This actor delivers that filing — and every other Senate PTR — as
clean, deduplicated JSON within hours of the official disclosure.
No third-party aggregators. Direct from the Senate eFD system.

Part of a set:
- **[House Trading Pipeline](https://apify.com/seralifatih/congress-trading-pipeline-1)** — same target schema, House Clerk PTRs. Run either or both.
- **[Congress Lobbying × Trades Overlap](https://apify.com/seralifatih/congress-lobbying-trades-overlap)** — joins House + Senate trades with federal lobbying filings by member, quarter, and sector.

## Who uses this

- **Retail traders** tracking which senators are buying/selling before
  major legislation — defense before NDAA votes, pharma before drug
  pricing bills, tech before antitrust hearings
- **Developers and analysts** building research tools, alerts, or
  dashboards on top of STOCK Act data
- **Journalists and researchers** monitoring congressional trading
  patterns — no account, no paywall, raw government data
- **Quiver Quantitative / Capitol Trades users** who want the raw feed
  instead of a third-party UI

**Why this instead of Quiver or Capitol Trades?**
They aggregate from the same source — the Senate eFD system. This
actor pulls directly from it. No middleman, no subscription.

---

## What it produces

One row per individual transaction reported in a Senate PTR:

```json
{
  "id": "a3f9c1...",
  "politician": "Jane Example",
  "transaction_date": "2026-03-16",
  "filing_date": "2026-03-20",
  "ticker": "LMT",
  "asset_name": "Lockheed Martin Corporation",
  "asset_type": "Stock",
  "type": "buy",
  "amount_min": 250001,
  "amount_max": 500000,
  "owner": "self",
  "source_id": "257795ae-e1b2-411d-b562-8fe4c2a4f2a1|6",
  "content_hash": "7c2e5b8d4f6a0c9e3b7d1fa3f9c1e2b8d47f60a1c5e93b2d8f7a4c6e0b1d9f3a",
  "filing_type": "original",
  "amendment_number": null,
  "parse_status": "ok",
  "pdf_url": null,
  "fetchedAt": "2026-03-20T18:04:11.000Z",
  "lastModifiedAt": "2026-03-20T18:04:11.000Z",
  "revisionCount": 0
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | SHA-256 of `politician\|date\|asset\|amount\|source_id` — unique per row, changes if source_id changes |
| `politician` | `string` | Filer name as it appears on the PTR |
| `transaction_date` | `YYYY-MM-DD \| null` | Trade execution date. `null` on any placeholder row (`fetch_failed`, `scanned_unparsed`, or `parse_failed`) — see `parse_status` |
| `filing_date` | `YYYY-MM-DD` | Date the PTR was submitted |
| `ticker` | `string \| null` | `null` for bonds, municipals, structured notes — also `null` on any placeholder row |
| `asset_name` | `string \| null` | Full asset description. `null` on any placeholder row |
| `asset_type` | `string \| null` | `Stock`, `Stock Option`, `Mutual Fund`, `Corporate Bond`, etc. `null` on any placeholder row |
| `type` | `'buy' \| 'sell' \| 'exchange' \| null` | `Purchase` → `buy`; `Sale (Full)`/`Sale (Partial)` → `sell`; `Exchange` (asset swap, e.g. shares exchanged in a merger or spinoff) → `exchange`. `null` on any placeholder row |
| `amount_min` | `integer \| null` | Lower bound of reported amount range, USD. `null` on any placeholder row |
| `amount_max` | `integer \| null` | Upper bound. `null` for unbounded "Over $X" disclosures, and on any placeholder row |
| `owner` | `'self' \| 'joint' \| 'spouse' \| 'child' \| null` | Account owner per STOCK Act categories. `null` on any placeholder row |
| `source_id` | `string` | Source PTR's document id + row ordinal (`<doc_id>\|<row_index>`), or `<doc_id>\|fetch_failed` / `<doc_id>\|paper` / `<doc_id>\|parse_failed` for the three placeholder kinds |
| `content_hash` | `string` | SHA-256 of `politician\|date\|asset\|type\|amount_min\|amount_max\|owner` (source_id excluded) — see "Duplicate transactions across filings" below |
| `filing_type` | `'original' \| 'amendment' \| null` | Read from the PTR's "(Amendment N)" label. `null` only when unlabeled, or on a placeholder row — never guessed |
| `amendment_number` | `integer \| null` | The N in "(Amendment N)"; `null` for originals and for a placeholder row |
| `parse_status` | `'ok' \| 'fetch_failed' \| 'scanned_unparsed' \| 'parse_failed'` | `'ok'` for a normally-parsed electronic PTR row. `'fetch_failed'` means the detail-page fetch itself failed after retries — transient, superseded once a later run succeeds. `'scanned_unparsed'` means the filing was submitted on paper, no OCR fallback. `'parse_failed'` means the page fetched fine but had zero parseable rows — see "Coverage" below |
| `pdf_url` | `string \| null` | Populated only on a placeholder row — the filing's detail page (no per-row PDF exists on this source). `null` on every normally-parsed row |
| `fetchedAt` | `string` (ISO 8601 UTC) | When this row was first pulled from source. Immutable — never updated by a later re-fetch of the same, unchanged row |
| `lastModifiedAt` | `string` (ISO 8601 UTC) | When this row's content last changed. Equal to `fetchedAt` until a revision is detected |
| `revisionCount` | `integer` | How many times this source row's content has changed since it was first seen. `0` if never revised |

Same core schema as the House actor — records from both merge cleanly
on field names and dedup semantics. `amendment_number` is Senate-only.

### Coverage

**Every filing the Senate eFD listing returns shows up in the output — either as transaction rows or as an explicitly flagged placeholder. No filing is silently dropped.**

| `parse_status` | Meaning | Billed? |
|---|---|---|
| `ok` | Normally parsed — a real transaction row | Yes |
| `fetch_failed` | Detail-page fetch failed after retries — transient, superseded once a later run succeeds | No |
| `scanned_unparsed` | Filing submitted on paper, no OCR fallback | No |
| `parse_failed` | Page fetched fine but had zero parseable rows — a parser bug or layout change | No |

**If you only want parsed transactions, filter `parse_status = "ok"`.**

**Measured (last 30 days, September 2026):** 49 filings reported by the Senate eFD listing, all 49 accounted for in the output — 3 of them paper filings. `fetch_failed` and `parse_failed` are rare and non-steady-state. Every run reports `fetchFailedCount` in its `OUTPUT` record.

### Duplicate transactions across filings

`id` is unique per row (it includes `source_id`), so rows never
collide — but the same real-world trade can still appear under two
different ids if it's reported in more than one source document (a
duplicate filing, or an amendment that re-lists a transaction from the
original). `content_hash` fingerprints only the trade's real-world
content (source_id excluded), so both copies hash identically and you
can find them.

**We never drop or merge rows.** A shared `content_hash`:

- **Same document (same `source_id` prefix):** a legitimate separate
  transaction — e.g. two same-day tranches of the same purchase. Keep
  both.
- **Different documents:** the same trade reported more than once.
  Summing across both double-counts it — reconcile by `content_hash`
  before aggregating.

Example: two purchases of the same structured note, same day, same
amount bracket, in the *same* PTR — different `source_id` rows, keep
both. Versus: the same 12 transactions appearing in two *separate* PTR
documents filed the same day — same `content_hash`, different
`source_id` prefixes; summing all 24 rows double-counts every trade.

### Fetch timestamps and immutable history

The Senate eFD system can revise a PTR after it's first posted — a
corrected amount, a fixed typo — with nothing on the source side
flagging that it happened. `fetchedAt` is set once, the first time a
row is pulled, and never changes after that, even across a revision.
`lastModifiedAt` moves to the revision's fetch time when the source
republishes a row with different content, and `revisionCount` counts
how many times that's happened. Rows are never overwritten in place —
a revision lands as a new row that carries `fetchedAt` forward from
the prior version, so both stay in the dataset.

To use it: keep a snapshot of a prior pull and diff it against a fresh
one. Where two rows share `source_id` but differ in `content_hash`,
`lastModifiedAt` tells you when the value changed.

---

## Use with Claude, Cursor, or any MCP client

Add this URL as an MCP server to give your AI agent direct access to both actors:

```text
https://mcp.apify.com?tools=seralifatih/congress-trading-pipeline,seralifatih/congress-trading-pipeline-1
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "congress-trades": {
      "url": "https://mcp.apify.com?tools=seralifatih/congress-trading-pipeline,seralifatih/congress-trading-pipeline-1"
    }
  }
}
```

Apify CLI:

```bash
apify mcp install cursor --tools seralifatih/congress-trading-pipeline,seralifatih/congress-trading-pipeline-1
```

On first connection you'll be asked to sign in to Apify. Runs are billed to your Apify account at the normal pay-per-result price.

---

## How it works

```
   Search fetch        Parse              Transform          Dedup         Store
┌────────────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────┐  ┌──────────┐
│ Senate EFD     │─▶│ JSON primary │─▶│ type, amount, │─▶│ SHA-256  │─▶│ Apify    │
│ search-index   │  │ HTML         │  │ dates, owner, │  │ natural  │  │ Dataset  │
│ 100/page loop  │  │ fallback     │  │ ticker        │  │ key      │  │          │
└────────────────┘  └──────────────┘  └───────────────┘  └──────────┘  └──────────┘
```

**1. Fetch.** Pages through the Senate eFD search index
(`efts.senate.gov`), 100 records per page, until the result set is
exhausted for the configured date window.

**2. Parse.** JSON response is primary. If a page yields empty asset
names across all rows (a known eFD quirk), the raw HTML is re-parsed
as fallback.

**3. Normalize.** Source purchase/sale codes map to `buy`/`sell`;
amount ranges, dates, and owner categories map to the canonical
schema shared with the House actor.

**4. Dedup + push.** The natural key is hashed to a stable ID;
duplicates across overlapping runs are dropped; a same-`source_id` row
with a changed `content_hash` is logged as a revision and its
`revisionCount`/`lastModifiedAt` updated; records land in the default
Apify dataset.

All HTTP calls retry 3 times with exponential backoff and ±25% jitter.

---

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `fetchDaysBack` | `integer` | `90` | Rolling window of PTRs to fetch (1–365) |
| `fromDate` | `string` (YYYY-MM-DD) | — | Explicit start date. Overrides `fetchDaysBack` |
| `toDate` | `string` (YYYY-MM-DD) | today | Explicit end date |

---

## How to use

**Apify Console (no code):** set your date window, run. Results land
in the dataset; export as JSON, CSV, or Excel.

**API:**

```bash
# Trigger a run
curl -X POST "https://api.apify.com/v2/acts/seralifatih~SENATE-ACTOR-SLUG/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "fetchDaysBack": 30 }'

# Read the dataset
curl "https://api.apify.com/v2/datasets/<dataset-id>/items?token=YOUR_TOKEN&format=json"
```

**Scheduled:** senators must disclose within 45 days of a trade, and
filings arrive continuously. A daily or every-6-hours schedule keeps
the feed current.

---

## Self-hosting

The pipeline also runs standalone as an Express API with SQLite
storage, a cron scheduler, and queryable REST endpoints — see the
[GitHub repository](https://github.com/seralifatih/senate-trading-pipeline)
for the self-hosted setup.

---

## Data source and permitted use

Data is sourced from public STOCK Act Periodic Transaction Reports published by the U.S. House Clerk and the U.S. Senate eFD system, and is provided for informational and research purposes.

Users are responsible for ensuring their use complies with 5 U.S.C. §13107(c), which prohibits obtaining or using these reports for any unlawful purpose; any commercial purpose other than by news and communications media for dissemination to the general public; determining an individual's credit rating; or soliciting money for political, charitable, or other purposes.

Not investment advice. Disclosures are filed up to 45 days after a trade and report amount ranges, not exact values.

This actor's source is [U.S. Senate Electronic Financial Disclosures (eFD)](https://efts.senate.gov),
a public government database. Senate PTR filings are required under
the [STOCK Act of 2012](https://en.wikipedia.org/wiki/STOCK_Act).
This actor does not scrape third-party aggregators. It pulls only
from the official source.

---

## License

The code is MIT-licensed. That license covers the code only; use of the data is governed by "Data source and permitted use" above.