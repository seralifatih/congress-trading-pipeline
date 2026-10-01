# U.S. Senate Trading Pipeline

A senator files a $250k purchase of defense stock the week before a
major procurement vote. The filing lands quietly on the Senate EFD
system.

This actor delivers that filing — and every other Senate PTR — as
clean, deduplicated JSON within hours of the official disclosure.
No third-party aggregators. Direct from the Senate eFD system.

Part of a set:
- **[House Trading Pipeline](https://apify.com/seralifatih/congress-trading-pipeline-1)** — same target schema, House Clerk PTRs. Run either or both.

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
  "politician_raw": "Jane Example",
  "member_bioguide_id": "E000123",
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
  "supersedes_filing_id": null,
  "is_superseded": false,
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
| `politician` | `string` | Filer name as it appears on the PTR. ALL-CAPS paper-filing names are re-cased to match electronic ones |
| `politician_raw` | `string` | The filer name exactly as the Senate listing printed it |
| `member_bioguide_id` | `string \| null` | Bioguide id from the congress-legislators roster; `null` when the filer is not a current senator or the name is ambiguous — never guessed |
| `transaction_date` | `YYYY-MM-DD \| null` | Trade execution date. `null` on any placeholder row (`fetch_failed`, `scanned_unparsed`, or `parse_failed`) — see `parse_status` |
| `filing_date` | `YYYY-MM-DD` | Date the PTR was submitted (ISO on every row, placeholders included). The run window selects on this date |
| `ticker` | `string \| null` | The source's own ticker, cleaned of artifacts. `null` when the source omits it (common for bonds, municipals, private/LLC holdings, structured notes and some stocks/ADRs), when it gave a company-name abbreviation instead, and on any placeholder row. Never guessed or looked up |
| `asset_name` | `string \| null` | Full asset description. `null` on any placeholder row |
| `received_ticker` | `string \| null` | Exchange rows only (`null` otherwise): the ticker of the asset *received*. See "Exchange rows" below |
| `received_asset_name` | `string \| null` | Exchange rows only (`null` otherwise): the description of the asset received, parsed from `asset_name`'s `"<given> (Exchanged) <received> (Received)"` form. `null` when the marker is missing |
| `asset_type` | `string \| null` | `Stock`, `Stock Option`, `Mutual Fund`, `Corporate Bond`, etc. `null` on any placeholder row |
| `type` | `'buy' \| 'sell' \| 'exchange' \| null` | `Purchase` → `buy`; `Sale (Full)`/`Sale (Partial)` → `sell`; `Exchange` (asset swap, e.g. shares exchanged in a merger or spinoff) → `exchange`. `null` on any placeholder row |
| `amount_min` | `integer \| null` | Lower bound of reported amount range, USD. `null` on any placeholder row |
| `amount_max` | `integer \| null` | Upper bound. `null` for unbounded "Over $X" disclosures, and on any placeholder row |
| `owner` | `'self' \| 'joint' \| 'spouse' \| 'child' \| null` | Account owner per STOCK Act categories. `null` on any placeholder row |
| `source_id` | `string` | Source PTR's document id + row ordinal (`<doc_id>\|<row_index>`), or `<doc_id>\|fetch_failed` / `<doc_id>\|paper` / `<doc_id>\|parse_failed` for the three placeholder kinds |
| `content_hash` | `string` | SHA-256 of `politician\|date\|asset\|type\|amount_min\|amount_max\|owner` (source_id excluded) — see "Duplicate transactions across filings" below |
| `filing_type` | `'original' \| 'amendment' \| null` | Read from the PTR's "(Amendment N)" label. `null` only when unlabeled, or on a placeholder row — never guessed |
| `amendment_number` | `integer \| null` | The N in "(Amendment N)"; `null` for originals and for a placeholder row |
| `row_index_in_filing` | `integer \| null` | 0-based position of the row among its filing's parsed rows, in source order — tells apart identical rows inside one filing (they share a `content_hash`). Not part of `id` or `content_hash`; `0` on a placeholder |
| `supersedes_filing_id` | `string \| null` | On an amendment's rows: the earlier filing by the same filer that it re-lists trades from. `null` when not determinable |
| `is_superseded` | `boolean` | `true` on the surviving rows of a filing that a later amendment supersedes |
| `parse_status` | `'ok' \| 'fetch_failed' \| 'scanned_unparsed' \| 'parse_failed'` | `'ok'` for a normally-parsed electronic PTR row. `'fetch_failed'` means the detail-page fetch itself failed after retries — transient, superseded once a later run succeeds. `'scanned_unparsed'` means the filing was submitted on paper, no OCR fallback. `'parse_failed'` means the page fetched fine but had zero parseable rows — see "Coverage" below |
| `pdf_url` | `string \| null` | Populated only on a placeholder row — the filing's detail page (no per-row PDF exists on this source). `null` on every normally-parsed row |
| `fetchedAt` | `string` (ISO 8601 UTC) | When this row was first pulled from source. Immutable — never updated by a later re-fetch of the same, unchanged row |
| `lastModifiedAt` | `string` (ISO 8601 UTC) | When this row's content last changed. Equal to `fetchedAt` until a revision is detected |
| `revisionCount` | `integer` | How many times this source row's content has changed since it was first seen. `0` if never revised |

Same core schema as the House actor — records from both merge cleanly
on field names and dedup semantics. `amendment_number` is Senate-only.

### Coverage

**Every filing the Senate eFD listing returns shows up in the output — either as transaction rows or as an explicitly flagged placeholder. No filing is silently dropped.**

| `parse_status` | Meaning | Billed as a "Transaction record"? |
|---|---|---|
| `ok` | Normally parsed — a real transaction row | Yes |
| `fetch_failed` | Detail-page fetch failed after retries — transient, superseded once a later run succeeds | Yes |
| `scanned_unparsed` | Filing submitted on paper, no OCR fallback | Yes |
| `parse_failed` | Page fetched fine but had zero parseable rows — a parser bug or layout change | Yes |

**If you only want parsed transactions, filter `parse_status = "ok"`.**

**Billing.** Every row written to the dataset is billed as a normal "Transaction record" event — **including placeholder rows** (`fetch_failed`, `scanned_unparsed`, `parse_failed`). The platform bills every item written to an Actor's default dataset, and the Actor cannot exempt individual rows. To avoid paying for placeholders, set `tickers` or a transaction-date filter (which withholds them), or use `members` to skip filers you don't need.

**Measured (last 30 days, September 2026):** 49 filings reported by the Senate eFD listing, all 49 accounted for in the output — 3 of them paper filings. `fetch_failed` and `parse_failed` are rare and non-steady-state. Every run reports `fetchFailedCount` in its `OUTPUT` record.

### Duplicate transactions across filings

`id` is unique per row by construction (it includes `source_id`), so two
rows never collide. But the same real-world trade can appear in more than
one source document: Senate offices sometimes file the same PTR twice, or
file an amendment that re-lists transactions from the original.
`content_hash` fingerprints only the transaction's real-world content —
politician, date, asset, buy/sell, amount range, owner — and leaves
`source_id` out, so two rows describing the same trade hash identically
regardless of which document produced them.

**Exact cross-filing duplicates are removed by default.** Within one run, if
rows from *different* filings by the same filer share a `content_hash`, one
copy is returned:

- the copy from the **highest-ranked filing** is kept — higher
  `amendment_number` first, then later `filing_date`. An amendment's copy
  always wins over the original's, so an amendment's rows are never the ones
  removed;
- this happens **before** anything is written or charged, so removed
  duplicates are never billed;
- set the `includeDuplicates` input to `true` to keep every copy.

Rows that share a `content_hash` **within one filing** are *not* touched: a
single PTR can legitimately list several identical tranches (e.g. a spouse's
capital contributions of the same bracket on the same day). Those are
distinct line items, and `row_index_in_filing` (0-based, source order)
tells them apart.

A row that differs in *any* hashed field is not an exact duplicate and is
kept — for example, an amendment that rewrites an `asset_name` leaves the
original's row in place next to the corrected one. That is what the two
supersession fields are for:

- `supersedes_filing_id` — on an amendment's rows: the `filing_id` of the
  earlier filing by the same filer that the amendment re-lists trades from.
- `is_superseded` — `true` on the surviving rows of that earlier filing.

**The Senate source has no "amends filing X" link**, so these are set only
where the data itself shows it: an amendment and a lower-ranked filing by the
same filer that share at least one identical trade. Anything else stays
`null` / `false` — "not determinable", not "not superseded". `filing_type`
and `amendment_number` are always kept as the source labels them.

**Worked example (measured, run of 2026-10-01, 316 rows).** Sen. Boozman's
original PTR `4a558db2…` and its Amendment 1 `4184cc9a…` (both filed
2026-08-17) list the same six trades. Five rows are byte-identical and are
returned once, from the amendment. The sixth differs only in `asset_name`
(`"SPYM - Tradr 2X Long SPY Monthly ETF"` vs `"Tradr 2X Long SPY Monthly
ETF"`), so the original's row is kept with `is_superseded: true` and the
amendment's rows carry `supersedes_filing_id: "4a558db2…"`. Sen.
Tuberville's Amendment 1 and Amendment 2 (both filed 2026-08-05) each carry
the same 12 trades; Amendment 2's copies are returned. On that run 17 of 316
rows were exact cross-filing duplicates.

Duplicates **across runs** are a different matter: two runs never see each
other's dataset, so a consumer merging datasets from several runs should
group by `content_hash` and keep the row from the highest `amendment_number`.

### Exchange rows

An Exchange swaps one asset for another, and the Senate source describes both
in one row: `asset_name` reads `"<given> (Exchanged) <received> (Received)"`
and the ticker cell can carry both tickers, given first. Wyden's PTR
`5ecc9b5c…` has `BERY - Berry Global Group, Inc. (Exchanged) Amcor plc Ordinary
Shares (Received)` with the cell `-- AMCR` — no ticker slot for the given
asset, `AMCR` for the received one.

- **`ticker`** is the **given** asset's ticker: the cell's first slot, else a
  ticker the `asset_name` text states for the given asset (`BERY`). So
  `tickers: ["BERY"]` keeps this row and `tickers: ["AMCR"]` does not.
- **`received_ticker`** / **`received_asset_name`** describe the asset
  received (`AMCR` / `Amcor plc Ordinary Shares`), when the source gives them.
- `asset_name` is unchanged, exactly as filed. Nothing is looked up or guessed;
  without the `(Exchanged)` marker the received fields stay `null`.
- Earlier versions of this actor (and the first 0.6.0 build) put `AMCR` in
  `ticker` for this row.

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

On first connection you'll be asked to sign in to Apify. Runs are billed to your Apify account at the normal pay-per-result price; every row written to the dataset, placeholders included, is one billed "Transaction record" (see "Coverage").

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
| `fetchDaysBack` | `integer` | `90` | Rolling window of PTRs to fetch (1–365), counted back from today. See "Window" below |
| `fromDate` | `string` (YYYY-MM-DD) | — | Explicit start of the window. Overrides `fetchDaysBack` |
| `toDate` | `string` (YYYY-MM-DD) | today | Explicit end of the window |
| `members` | `string[]` | — | Only these senators. Case-insensitive; matches the normalized name **and nicknames**. See "Filters" below |
| `tickers` | `string[]` | — | Only transactions in these tickers (case-insensitive). Rows with no ticker are excluded |
| `transactionDateFrom` | `string` (YYYY-MM-DD) | — | Only trades executed on or after this date (inclusive) |
| `transactionDateTo` | `string` (YYYY-MM-DD) | — | Only trades executed on or before this date (inclusive) |
| `includeDuplicates` | `boolean` | `false` | Keep exact cross-filing duplicate rows instead of removing them. See "Duplicate transactions across filings" |
| `debugPtrLimit` | `integer` | `0` | Diagnostic — fetch detail for only the first N PTRs (after the `members` filter). Handy for a cheap test run |

Every field is optional; an empty input behaves as before.

### Window

**The window selects filings by *filing date*** — the date the PTR was
submitted to the Senate — not by the date of the trades inside it. A filing
submitted today can report a trade from two years ago and is returned by a
one-day window; a trade made yesterday that hasn't been filed yet is returned
by no window. Use `transactionDateFrom`/`transactionDateTo` to select by
trade date; they apply **on top of** the filing-date window, so a trade is
returned only if its filing is inside the window too (widen `fetchDaysBack`
or `fromDate` to catch late-filed older trades — the run logs a warning when
`transactionDateFrom` reaches back past the window).

`fetchDaysBack` and `debugPtrLimit` are honoured as of this version. Before,
they were set as environment variables after the code had already read its
environment, so a run with `fetchDaysBack: 30` silently used the 90-day
default (and `debugPtrLimit` did nothing). See the CHANGELOG.

### Filters

All filters are applied **before anything is written or charged** — you are
never billed for a row a filter removed.

- **`members`** is applied against the filing list **before each filing's
  detail page is fetched**, so excluded senators cost no requests. An entry
  matches a filer when any of these hold: it resolves to the same member
  (`"Tommy Tuberville"` matches `"Thomas H Tuberville"`; `"Mitch McConnell"`
  matches `"A. Mitchell McConnell, Jr."`); all of its name tokens appear in the
  filer's name after nickname normalization; or it is a bioguide id
  (`T000278`). A bare last name (`"Scott"`) matches every senator with that
  last name — add a first name to narrow it. Member resolution uses the
  [congress-legislators](https://github.com/unitedstates/congress-legislators)
  roster; if that
  download fails the run logs a warning and falls back to name-token matching.
- **`transactionDateFrom`** also prunes early: a PTR can only report trades
  that already happened, so a filing submitted before that date cannot contain
  a trade on or after it and its detail page is never fetched.
  `transactionDateTo` has no such shortcut (a filing made today can report a
  trade from 2024), so it is applied to each row after parsing.
- **`tickers`** and the exact trade-date bounds need the filing's detail
  page, so they are applied to each parsed row.
- When `tickers`, `transactionDateFrom` or `transactionDateTo` is set,
  **placeholder rows** (`fetch_failed`, `scanned_unparsed`,
  `parse_failed`) are not emitted: their content is unknown, so the filter
  can't be evaluated. They are counted as `placeholdersExcludedCount` in
  `RUN_SUMMARY`. A `members` filter alone keeps them (the filer is known).

### Max charge reached (`RUN_SUMMARY`)

If the run's **maximum total charge** is reached before every row is
written, the run still ends `SUCCEEDED` — that is how the platform behaves —
but it no longer does so silently. The actor stops writing at the cap, logs a
warning, sets the run's status message, and writes a `RUN_SUMMARY` record to
the run's key-value store:

```json
{
  "truncated": true,
  "reason": "max_total_charge_reached",
  "rowsEmitted": 316,
  "rowsNotEmitted": 84,
  "lastFilingDate": "2026-08-05",
  "lastFilingId": "…",
  "windowFrom": "2026-07-03",
  "windowTo": "2026-10-01"
}
```

`RUN_SUMMARY` is written on every successful run (`truncated: false`,
`reason: null` when nothing was cut). Rows are written **newest filing
first**, so a truncated run is missing the *oldest* filings;
`lastFilingDate` is the filing date of the last row written (a filing at the
cap may be partly written). To fetch the rest, raise the maximum charge and/or
narrow the window or filters — e.g. re-run with `toDate` set to
`lastFilingDate` (that day's filings overlap with the first run).
`RUN_SUMMARY` also reports `duplicatesCollapsed` (exact cross-filing duplicates
removed before writing), `placeholdersWithheld` (placeholder rows not emitted
because a `tickers` or transaction-date filter was set),
`skippedByMemberCount`, `skippedByTransactionDateCount`,
`filteredByTickerCount` and `filteredByTransactionDateCount`. (`duplicatesRemoved`
and `placeholdersExcludedCount` are the same two numbers under their earlier names.)

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