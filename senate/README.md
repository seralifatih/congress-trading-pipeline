# U.S. Senate Trading Pipeline

Every U.S. Senate Periodic Transaction Report — the stock trades senators are legally required to disclose under the STOCK Act — delivered as clean, deduplicated JSON within hours of the filing hitting the official record. One row per transaction, with normalized buy/sell direction, integer dollar ranges, tickers, and stable IDs, so you can point a screener, an alerting rule, or a backtest straight at the dataset without writing a parser or reconciling a vendor's schema. Pulled directly from the Senate eFD system — no aggregator in the middle, no subscription.

Part of a set:
- **[House Trading Pipeline](https://apify.com/seralifatih/congress-trading-pipeline-1)** — same target schema, House Clerk PTRs. Run either or both.
- **[Congress Lobbying × Trades Overlap](https://apify.com/seralifatih/congress-lobbying-trades-overlap)** — joins House + Senate trades with federal lobbying filings by member, quarter, and sector.

---

## What it produces

One row per individual transaction reported in a Senate PTR:

```json
{
  "id": "a3f9c1e2b8d47f60a1c5e93b2d8f7a4c6e0b1d9f3a7c2e5b8d4f6a0c9e3b7d1f",
  "politician": "Jane Example",
  "politician_raw": "Jane Example",
  "member_bioguide_id": "E000123",
  "transaction_date": "2026-03-16",
  "filing_date": "2026-03-20",
  "ticker": "LMT",
  "asset_name": "Lockheed Martin Corporation",
  "received_ticker": null,
  "received_asset_name": null,
  "asset_type": "Stock",
  "type": "buy",
  "amount_min": 250001,
  "amount_max": 500000,
  "owner": "self",
  "source_id": "257795ae-e1b2-411d-b562-8fe4c2a4f2a1|6",
  "content_hash": "7c2e5b8d4f6a0c9e3b7d1fa3f9c1e2b8d47f60a1c5e93b2d8f7a4c6e0b1d9f3a",
  "filing_type": "original",
  "amendment_number": null,
  "row_index_in_filing": 6,
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
| `politician` | `string` | Filer name as it appears on the PTR. Paper filings arrive from the source in ALL CAPS (`RICHARD BLUMENTHAL`); those are re-cased to match electronic ones (`Richard Blumenthal`). Mixed-case names are untouched |
| `politician_raw` | `string` | The filer name exactly as the Senate listing printed it, before any casing normalization |
| `member_bioguide_id` | `string \| null` | [Bioguide id](https://bioguide.congress.gov) from the congress-legislators roster, resolved from the filer name (nicknames, middle names/initials and suffixes handled). `null` when the filer is not a current senator or the name matches more than one member — never guessed |
| `transaction_date` | `YYYY-MM-DD \| null` | Trade execution date. `null` on any placeholder row (`fetch_failed`, `scanned_unparsed`, or `parse_failed`) — see `parse_status` |
| `filing_date` | `YYYY-MM-DD` | Date the PTR was submitted. ISO on every row, placeholders included (paper-filing placeholders used to carry the listing's raw `MM/DD/YYYY`). This is the date the run window selects on |
| `ticker` | `string \| null` | The source's own ticker, cleaned of artifacts (`"-- AMCR"` → `AMCR`). `null` when the source omits it, when it gave a company-name abbreviation instead of a ticker (`COLPAL`), and on any placeholder row — see "Missing tickers" under Known limitations. Never guessed or looked up |
| `asset_name` | `string \| null` | Full asset description. `null` on any placeholder row |
| `received_ticker` | `string \| null` | Exchange rows only (`null` otherwise): the ticker of the asset *received*. See "Exchange rows" below |
| `received_asset_name` | `string \| null` | Exchange rows only (`null` otherwise): the description of the asset received, parsed from `asset_name`'s `"<given> (Exchanged) <received> (Received)"` form. `null` when the marker is missing |
| `asset_type` | `string \| null` | `Stock`, `Stock Option`, `Mutual Fund`, `Corporate Bond`, etc. — as labeled by the Senate EFD source. `null` on any placeholder row |
| `asset_subtype` | `'ETF' \| 'Mutual Fund' \| null` | Derived from `asset_name`, only when `asset_type` is `Stock` — Senate's own asset-type checkboxes have no ETF/fund option, so filers commonly mark those as `Stock`. `null` for every other `asset_type` (e.g. `Other`, `Non-Public Stock`), where the source's own label is treated as more reliable than a name-text guess. Also `null` on any placeholder row |
| `type` | `'buy' \| 'sell' \| 'exchange' \| null` | `Purchase` → `buy`; `Sale (Full)`/`Sale (Partial)` → `sell`; `Exchange` (asset swap, e.g. shares exchanged in a merger or spinoff) → `exchange`. `null` on any placeholder row |
| `amount_min` | `integer \| null` | Lower bound of reported amount range, USD. `null` on any placeholder row |
| `amount_max` | `integer \| null` | Upper bound. `null` for unbounded "Over $X" disclosures, and on any placeholder row |
| `owner` | `'self' \| 'joint' \| 'spouse' \| 'child' \| null` | Account owner per STOCK Act categories. `null` on any placeholder row |
| `source_id` | `string` | The source PTR's document id plus the row's ordinal within it (`<doc_id>\|<row_index>`), or `<doc_id>\|fetch_failed` / `<doc_id>\|paper` / `<doc_id>\|parse_failed` for the three placeholder kinds — identifies exactly which document (and, for a real row, which line) produced this row |
| `content_hash` | `string` | SHA-256 of `politician\|date\|asset\|type\|amount_min\|amount_max\|owner` — deliberately excludes `source_id`. See "Duplicate transactions across filings" below |
| `filing_type` | `'original' \| 'amendment' \| null` | Read from the PTR's own "(Amendment N)" label. `null` only when the source page didn't expose a label, or on a placeholder row — never guessed from duplication |
| `amendment_number` | `integer \| null` | The N in "(Amendment N)". `null` for originals, for anything the source doesn't label, and for a placeholder row |
| `row_index_in_filing` | `integer \| null` | 0-based position of the row among its filing's parsed rows, in source order — tells apart identical rows inside one filing (they share a `content_hash`). Not part of `id` or `content_hash`; `0` on a placeholder |
| `supersedes_filing_id` | `string \| null` | On an amendment's rows: the `filing_id` of the earlier filing by the same filer that the amendment re-lists trades from. `null` when not determinable — see "Duplicate transactions across filings" |
| `is_superseded` | `boolean` | `true` on the surviving rows of a filing that a later amendment supersedes by that rule. `false` otherwise |
| `parse_status` | `'ok' \| 'fetch_failed' \| 'scanned_unparsed' \| 'parse_failed'` | `'ok'` for a normally-parsed electronic PTR row. `'fetch_failed'` means the PTR detail-page fetch itself failed after retries — a transient network/host issue, superseded automatically once a later run succeeds. `'scanned_unparsed'` means this filing was submitted **on paper** — Senate EFD serves it as a scanned image/PDF at `/search/view/paper/<id>/`, and there's no OCR fallback. `'parse_failed'` means the `/ptr/<uuid>/` page fetched fine (not a paper filing) but had zero parseable table rows — a parser bug or a Senate EFD layout change. See "Coverage" below |
| `pdf_url` | `string \| null` | Populated only on a placeholder row — the filing's detail page (Senate has no per-row PDF; the whole filing's data lives on that one page). `null` on every normally-parsed row |
| `fetchedAt` | `string` (ISO 8601 UTC) | When this row was first pulled from source. Immutable — never updated by a later re-fetch of the same, unchanged row. See "Fetch timestamps and immutable history" below |
| `lastModifiedAt` | `string` (ISO 8601 UTC) | When this row's content last changed. Equal to `fetchedAt` until a revision is detected |
| `revisionCount` | `integer` | How many times this source row's content has changed since it was first seen. `0` for a row that has never been revised |

Same core schema as the House actor — records from both merge cleanly
on field names and dedup semantics. `amendment_number` is Senate-only;
the House source has no equivalent sequence number (see its README).

### Coverage

**Every filing the Senate eFD listing returns shows up in the output — either as transaction rows or as an explicitly flagged placeholder. No filing is silently dropped.**

| `parse_status` | Meaning | Null fields | Billed as a "Transaction record"? |
|---|---|---|---|
| `ok` | Normally parsed — a real transaction row | none | Yes |
| `fetch_failed` | The `/ptr/<uuid>/` detail-page fetch itself failed after retries (network error, timeout, non-2xx, or a session redirect that re-handshake couldn't resolve). The filing's content was never examined. Transient — a later run that successfully fetches the same filing automatically replaces this placeholder with real rows | all transaction-detail fields | Yes |
| `scanned_unparsed` | This filing was submitted **on paper** — Senate EFD serves it as a scanned image/PDF at `/search/view/paper/<id>/`, not the structured HTML table electronic PTRs get. No OCR fallback. Permanent, not transient | all transaction-detail fields | Yes |
| `parse_failed` | The `/ptr/<uuid>/` page fetched successfully (so this is *not* a paper filing) but had zero parseable table rows — a parser bug or a Senate EFD layout change | all transaction-detail fields | Yes |

A placeholder row carries `politician`, `filing_date`, `source_id`, and `pdf_url` (the filing's detail page — Senate has no per-row PDF); every transaction-detail field (`transaction_date`, `ticker`, `asset_name`, `asset_type`, `asset_subtype`, `type`, `amount_min`, `amount_max`, `owner`) is `null`.

**If you only want parsed transactions, filter `parse_status = "ok"`.**

**Billing.** Every row written to the dataset is billed as a normal "Transaction record" event — **including placeholder rows** (`fetch_failed`, `scanned_unparsed`, `parse_failed`). The platform bills every item written to an Actor's default dataset, and the Actor cannot exempt individual rows. To avoid paying for placeholders, set `tickers` or a transaction-date filter (which withholds them), or use `members` to skip filers you don't need.

**Measured (last 30 days, September 2026):** 49 filings reported by the Senate eFD listing, all 49 accounted for in the output — 3 of them paper filings (`scanned_unparsed`). `fetch_failed` and `parse_failed` are expected to be rare and transient/one-off respectively, not steady-state percentages — every pipeline run logs and reports `fetchFailedCount` (and the `emptyPtrCount`/`parse_failed` count) in its `OUTPUT` key-value record so a spike or a new parser gap doesn't go unnoticed.

**Revision tracking:** `fetchedAt`, `lastModifiedAt`, and `revisionCount` — including for placeholders — let you tell "we don't have this yet" (a fresh `fetch_failed` placeholder) apart from "we've retried and it's still failing" (a `fetch_failed` placeholder with `revisionCount > 0`). See "Fetch timestamps and immutable history" below.

### Paper, fetch-failed, and parse-failed filings

Not every Senate PTR is filed electronically. Some are submitted on paper and
served by Senate EFD as a scanned image/PDF at `/search/view/paper/<id>/` —
a different link shape from an electronic PTR's `/search/view/ptr/<uuid>/`,
visible in the listing itself before any detail page is fetched. There is no
OCR fallback (same policy as the House actor's scanned PDFs), so a paper
filing becomes a single placeholder row: `politician`, `filing_date`,
`source_id`, and `pdf_url` (the filing's detail page) are populated;
`transaction_date`, `ticker`, `asset_name`, `asset_type`, `asset_subtype`,
`type`, `amount_min`, `amount_max`, and `owner` are all `null`, and
`parse_status` is `'scanned_unparsed'`.

**If you're filtering or aggregating this dataset, filter on
`parse_status === 'ok'` first** — a placeholder has no
transaction data to analyze, and its null fields will otherwise show up as
gaps in downstream stats (e.g. a null `amount_min` breaking a sum).

Two more placeholder kinds cover different failure layers. An electronic PTR
(`/ptr/` link) whose detail page has zero table rows produces a
`'parse_failed'` placeholder — that's a parser or Senate EFD layout break,
not a known-unreadable filing, but it still gets flagged rather than
silently dropped. And a `/ptr/` detail-page fetch that fails outright after
retries (network error, timeout) produces a `'fetch_failed'` placeholder —
transient, and automatically superseded by real rows once a later run's
fetch succeeds for the same filing.

Every production run reports counters — `electronic_ptr_count`,
`paper_count`, `empty_ptr_count`, `fetch_failed_count` — in the actor's log
output and its `OUTPUT` record in the run's key-value store, so the
electronic-vs-paper ratio (and any transient fetch failures) for any given
run can be read back without re-scraping the listing.

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

Source data isn't static. The Senate eFD system can revise a PTR after
it's initially posted — the office refiles a corrected amount, fixes a
typo in the asset name, whatever the reason. When that happens, the
row you pulled last week and the row you'd pull today can describe the
same trade with different values, and nothing on the Senate's side
flags that it happened.

`fetchedAt` and `lastModifiedAt` exist so that revision is dateable
instead of invisible:

- **`fetchedAt`** is set once, the first time this row is pulled, and
  never changes after that — not even across a revision. It answers
  "when did I first learn this row exists."
- **`lastModifiedAt`** tracks when the row's content last changed.
  It equals `fetchedAt` until the source revises the row, at which
  point it moves to the revision's fetch time.
- **`revisionCount`** counts how many times that's happened.

Rows are never overwritten in place — a revision lands as a new row
(with its own new `id`, since amount/date/asset feed the id's hash)
that carries `fetchedAt` forward from the prior version. Both the old
and new version stay in the dataset, so the history is additive, not
destructive.

**How to use it:** keep your own snapshot of a prior pull (a plain
export is enough) and diff it against a fresh one. Where two rows
share `source_id` but differ in `content_hash`, `lastModifiedAt` tells
you exactly when the value you were relying on changed — turning a
silent discrepancy into a dated one you can trace back through a
backtest or an alert history.

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

On first connection you'll be asked to sign in to Apify. Runs are billed to your Apify account at the normal pay-per-result price. On pay-per-event pricing every row written to the dataset is billed, placeholders included — a `fetch_failed`, `scanned_unparsed`, or `parse_failed` placeholder is written to the dataset and billed like any other row — see "Coverage".

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

**1. Fetch.** Completes the eFD CSRF handshake, then pages through the
Senate eFD search index (`efts.senate.gov`), 100 records per page,
until the result set is exhausted for the configured date window.

**2. Parse.** JSON response is primary. If a page yields empty asset
names across all rows (a known eFD quirk), the raw HTML is re-parsed
as fallback.

**3. Normalize.** Source purchase/sale codes map to `buy`/`sell`;
amount ranges, dates, and owner categories map to the canonical
schema shared with the House actor.

**4. Dedup.** The natural key (`politician|date|asset|amount|source_id`)
is hashed to a stable SHA-256 ID, so re-running over an overlapping
date window will not produce duplicate rows from the same source
document. A separate `content_hash` (source_id excluded) lets you spot
the same real-world trade reported across two different documents —
see "Duplicate transactions across filings" above. If a row's
`source_id` was seen before with a different `content_hash`, it's
logged as a revision and `revisionCount`/`lastModifiedAt` are updated
accordingly — see "Fetch timestamps and immutable history" above.

**5. Store.** Records land in the default Apify dataset, queryable
via the Apify API or exportable as JSON, CSV, or Excel.

All HTTP calls retry 3 times with exponential backoff and ±25% jitter.

---

## How to use

**Apify Console (no code):** set your date window, run. Results land
in the dataset; export as JSON, CSV, or Excel.

**API:**

```bash
# Trigger a run
curl -X POST "https://api.apify.com/v2/acts/seralifatih~congress-trading-pipeline/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "fetchDaysBack": 30 }'

# Read the dataset
curl "https://api.apify.com/v2/datasets/<dataset-id>/items?token=YOUR_TOKEN&format=json"
```

**Scheduled:** senators must disclose within 45 days of a trade, and
filings arrive continuously. A daily or every-6-hours schedule keeps
the feed current.

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
  roster (the same source the Lobbying × Trades Overlap actor uses); if that
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

## Known limitations

Stated plainly, so you can decide whether they matter for your use case:

- **Amount ranges, not exact figures.** The STOCK Act only requires
  senators to disclose a bracket (`$1,001 - $15,000`). Nobody publishes
  exact trade sizes — no data source can, including paid ones. Size any
  model on the range, not a point estimate.
- **Unbounded upper bounds.** "Over $50,000,000" disclosures set
  `amount_max` to `null`. Handle the null rather than assuming a
  numeric ceiling.
- **Reporting lag is real.** Disclosure is due within 45 days of the
  trade, and late filings are common. `filing_date` minus
  `transaction_date` is frequently weeks. This is a disclosure feed,
  not a real-time trade feed — do not model it as one.
- **Missing tickers.** About a third of rows have `ticker: null` with
  `asset_name` populated. In a 314-row sample (30-day window, run of
  2026-10-01) the 112 null-ticker rows were: 47 municipal bonds, 33
  `Other` (private LLCs, partnerships, hedge-fund interests), 21 `Stock`
  (of which 3 are Goldman structured notes; the rest are listed stocks and
  ADRs — Qualcomm, Nestle, Otis — whose ticker cell in the source is
  literally `--`), 8 `Non-Public Stock`, and 3 `Corporate Bond`. None were
  parse misses: the source leaves the ticker blank for these. A ticker is
  used only when the source gives one (or `asset_name` states it as
  `(XXXX)` / `XXXX - Name`); nothing is looked up or guessed. Ticker
  enrichment is Phase 2.
- **Filer names are as-filed** (apart from re-casing ALL-CAPS paper
  filings). `member_bioguide_id` gives a canonical key for current
  senators, but there is no party or committee data, and a filer who is
  not a current senator has a `null` bioguide id.
- **Rows the source leaves blank.** An unparseable amount normalizes to
  `amount_min: 0`; an unparseable date drops the row rather than
  guessing. Both are logged.
- **Senate only.** House filings come from a different system with a
  different format — use the
  [House Trading Pipeline](https://apify.com/seralifatih/congress-trading-pipeline-1)
  for those.

---

## Data source and permitted use

Data is sourced from public STOCK Act Periodic Transaction Reports published by the U.S. House Clerk and the U.S. Senate eFD system, and is provided for informational and research purposes.

Users are responsible for ensuring their use complies with 5 U.S.C. §13107(c), which prohibits obtaining or using these reports for any unlawful purpose; any commercial purpose other than by news and communications media for dissemination to the general public; determining an individual's credit rating; or soliciting money for political, charitable, or other purposes.

Not investment advice. Disclosures are filed up to 45 days after a trade and report amount ranges, not exact values.

This actor's source is [U.S. Senate Electronic Financial Disclosures (eFD)](https://efts.senate.gov),
a public government database. Senate PTR filings are required under
the [STOCK Act of 2012](https://en.wikipedia.org/wiki/STOCK_Act),
which obliges members of Congress to publicly report securities
transactions over $1,000 within 45 days. This actor does not scrape
third-party aggregators. It pulls only from the official source.

---

## Self-hosting

The pipeline also runs standalone as an Express API with SQLite
storage, a cron scheduler, and queryable REST endpoints:

```bash
git clone https://github.com/seralifatih/senate-trading-pipeline
cd senate-trading-pipeline
npm install
cp .env.example .env   # all vars have defaults
npm run dev            # starts on http://localhost:3001, runs pipeline immediately
```

Storage is pluggable via the `StoreAdapter` interface — SQLite ships
for local runs, Apify Dataset for cloud runs. See the
[GitHub repository](https://github.com/seralifatih/senate-trading-pipeline)
for the full environment variable reference and API docs.

---

## License

The code is MIT-licensed. That license covers the code only; use of the data is governed by "Data source and permitted use" above.
