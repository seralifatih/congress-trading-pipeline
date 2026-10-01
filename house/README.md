# U.S. House Trading Pipeline

Nancy Pelosi files a $500k–$1M purchase of Nvidia options.
Three days later it's on Reddit. Two weeks later it's on the news.

This pipeline delivers that filing — and every other House PTR —
as clean JSON, within 24 hours of the official disclosure.
No third-party aggregators. Direct from the Clerk of the House.

Part of a set:
- **[Senate Trading Pipeline](https://github.com/seralifatih/senate-trading-pipeline)** — same target schema, separate fetcher + PDF parser. Run either or both.

## Who uses this

- **Retail traders** tracking which Congress members are buying/selling
  before major legislation — defense stocks before NDAA votes, pharma
  before drug pricing bills, tech before antitrust hearings
- **Developers and analysts** building research tools, alerts, or
  dashboards on top of STOCK Act data
- **Journalists and researchers** monitoring congressional trading
  patterns — no account, no paywall, raw government data
- **Quiver Quantitative / Capitol Trades users** who want the raw feed
  instead of a third-party UI

**Why this instead of Quiver or Capitol Trades?**
Both aggregate from the same source — the Clerk of the House. This
pipeline pulls directly from the official ZIP archive. No middleman,
no rate limits, no subscription.

---

## What it produces

One row per individual transaction reported in a House PTR:

```json
{
  "id": "4d6016b44239f646476ffac6798f21ae3e32c8ed75ea6c5b50a0bbdf9e5d3296",
  "politician": "Mark Alford",
  "politician_raw": "Mark Alford",
  "member_bioguide_id": "A000000",
  "transaction_date": "2026-03-16",
  "filing_date": "2026-03-31",
  "ticker": "AMZN",
  "asset_name": "Amazon.com, Inc. - Common Stock",
  "asset_type": "Stock",
  "type": "sell",
  "amount_min": 1001,
  "amount_max": 15000,
  "owner": "self",
  "source_id": "house_20034201_0",
  "content_hash": "9e5d3296a3f9c1e2b8d47f60a1c5e93b2d8f7a4c6e0b1d9f3a7c2e5b8d4f6a0c",
  "filing_type": "original",
  "row_index_in_filing": 0,
  "supersedes_filing_id": null,
  "is_superseded": false,
  "parse_status": "ok",
  "pdf_url": "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034201.pdf",
  "fetchedAt": "2026-03-31T09:12:44.000Z",
  "lastModifiedAt": "2026-03-31T09:12:44.000Z",
  "revisionCount": 0
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | SHA-256 of `politician\|date\|asset\|amount_min\|amount_max\|source_id` — unique per row, changes if source_id changes |
| `politician` | `string` | Filer name as the House Clerk index prints it. A doubled token in the source (`Scott Scott Franklin`) is collapsed (`Scott Franklin`); ALL-CAPS names are re-cased. See `politician_raw` |
| `politician_raw` | `string` | The filer name exactly as the index printed it (`First Last Suffix`), before normalization |
| `member_bioguide_id` | `string \| null` | [Bioguide id](https://bioguide.congress.gov) from the congress-legislators roster (same approach as the Senate actor). `null` when the filer is not a current House member or the name matches more than one — never guessed |
| `transaction_date` | `YYYY-MM-DD \| null` | Trade execution date. `null` on a placeholder row (`scanned_unparsed` or `parse_failed`) — see `parse_status` |
| `filing_date` | `YYYY-MM-DD` | Date the PTR was submitted to the House Clerk. This is the date the run window selects on |
| `ticker` | `string \| null` | The source's own ticker, cleaned of artifacts (`"-- AMCR"` → `AMCR`). `null` when the source omits it (Treasuries, municipals, private funds, …), when it gave a company-name abbreviation instead of a ticker (`COLPAL`), and on a placeholder row. Never guessed or looked up — see "Known limitations" |
| `asset_name` | `string \| null` | Full asset description. `null` on a placeholder row |
| `asset_type` | `string \| null` | `Stock`, `Stock Option`, `Mutual Fund`, `Corporate Bond`, `Government Security`, etc. `null` on a placeholder row |
| `asset_subtype` | `'ETF' \| 'Mutual Fund' \| null` | Derived directly from the source PDF's own asset-type marker code (`[ET]` → `ETF`, `[MF]` → `Mutual Fund`) — a direct source signal, unlike the Senate actor's name-text guess. `null` for every other `asset_type`, and on a placeholder row |
| `type` | `'buy' \| 'sell' \| 'exchange' \| null` | `Purchase` → `buy`; `Sale (Full)`/`Sale (Partial)` → `sell`; `Exchange` (asset type code `[E]` — e.g. shares received/surrendered in a merger) → `exchange`. `null` on a placeholder row |
| `amount_min` | `integer \| null` | Lower bound of reported amount range, USD. `null` on a placeholder row |
| `amount_max` | `integer \| null` | Upper bound. `null` for unbounded "Over $X" disclosures, and on a placeholder row |
| `owner` | `'self' \| 'joint' \| 'spouse' \| 'child' \| null` | Account owner per STOCK Act categories. `null` on a placeholder row |
| `source_id` | `string` | Source PTR's DocID + row ordinal (`house_<DocID>_<row_index>`), or `house_<DocID>_fetch_failed` / `house_<DocID>_scanned` / `house_<DocID>_parse_failed` for the three placeholder kinds |
| `content_hash` | `string` | SHA-256 of `politician\|date\|asset\|type\|amount_min\|amount_max\|owner` (source_id excluded) — see "Duplicate transactions across filings" below |
| `filing_type` | `'original' \| 'amendment' \| null` | Read from the PTR's own per-row "Filing Status: New/Amended" line. `null` only when that line is missing or unrecognized — never guessed from duplication. No amendment-number equivalent exists in this source (unlike Senate) |
| `amendment_number` | `integer \| null` | Always `null` on this actor — schema parity with the Senate actor's "(Amendment N)" label, which has no equivalent in this source |
| `row_index_in_filing` | `integer \| null` | 0-based position of the row among its filing's parsed rows, in source order — tells apart repeated line items inside one filing (they share a `content_hash`). Not part of `id` or `content_hash`; `0` on a placeholder |
| `supersedes_filing_id` | `string \| null` | On an amended filing's rows: the earlier filing by the same filer that it re-lists trades from. `null` when not determinable — see "Duplicate transactions across filings" |
| `is_superseded` | `boolean` | `true` on the surviving rows of a filing that a later amended filing supersedes by that rule |
| `parse_status` | `'ok' \| 'fetch_failed' \| 'scanned_unparsed' \| 'parse_failed'` | `'ok'` for a normally-parsed row. `'fetch_failed'` means the PDF download itself failed after retries — a transient network/host issue, superseded automatically once a later run succeeds. `'scanned_unparsed'` means this filing's PDF has no extractable text layer at all (scanned/paper PTR, no OCR fallback). `'parse_failed'` means the PDF DOES have a text layer and transaction markers were found, but no row matched the expected shape — a parser gap, not a known source-format limitation. See "Coverage" and "Scanned, paper, and parse-failed filings" below |
| `pdf_url` | `string` | The source House PTR PDF this row was parsed from (or, for a placeholder row, the PDF that couldn't be read/matched) |
| `fetchedAt` | `string` (ISO 8601 UTC) | When this row was first pulled from source. Immutable — never updated by a later re-fetch of the same, unchanged row. See "Fetch timestamps and immutable history" below |
| `lastModifiedAt` | `string` (ISO 8601 UTC) | When this row's content last changed. Equal to `fetchedAt` until a revision is detected |
| `revisionCount` | `integer` | How many times this source row's content has changed since it was first seen. `0` if never revised |

### Coverage

**Every filing the House Clerk's index lists shows up in the output — either as transaction rows or as an explicitly flagged placeholder. No filing is silently dropped.**

| `parse_status` | Meaning | Null fields | Billed as a "Transaction record"? |
|---|---|---|---|
| `ok` | Normally parsed — a real transaction row | none | Yes |
| `fetch_failed` | The PDF download itself failed after retries (network error, timeout, non-2xx). The filing's content was never examined. Transient — a later run that successfully fetches the same filing automatically replaces this placeholder with real rows | all transaction-detail fields | Yes |
| `scanned_unparsed` | The PDF has no extractable text layer at all (a scanned/paper PTR). No OCR fallback | all transaction-detail fields | Yes |
| `parse_failed` | The PDF has a text layer and transaction markers were found, but no row matched the expected shape — a parser gap, not a known source-format limitation | all transaction-detail fields | Yes |

A placeholder row (`fetch_failed`, `scanned_unparsed`, or `parse_failed`) carries `politician`, `filing_date`, `source_id`, and `pdf_url`; every transaction-detail field (`transaction_date`, `ticker`, `asset_name`, `asset_type`, `asset_subtype`, `type`, `amount_min`, `amount_max`, `owner`) is `null`.

**If you only want parsed transactions, filter `parse_status = "ok"`.**

**Billing.** Every row written to the dataset is billed as a normal "Transaction record" event — **including placeholder rows** (`fetch_failed`, `scanned_unparsed`, `parse_failed`). The platform bills every item written to an Actor's default dataset, and the Actor cannot exempt individual rows. To avoid paying for placeholders, set `tickers` or a transaction-date filter (which withholds them), or use `members` to skip filers you don't need.

**Measured (last 90 days, September 2026):** 133 of 133 PTR filings reported by the House index are accounted for in the output — 133 in, 133 (or their placeholders) out. Roughly 14% (~19 filings) are scanned paper PTRs (`scanned_unparsed`). `fetch_failed` and `parse_failed` are expected to be rare and transient/one-off respectively, not steady-state percentages — every pipeline run logs and reports `fetchFailedCount` / `parseFailedCount` in its `OUTPUT` key-value record so a spike or a new parser gap doesn't go unnoticed.

**Revision tracking:** `fetchedAt`, `lastModifiedAt`, and `revisionCount` — including for placeholders — let you tell "we don't have this yet" (a fresh `fetch_failed` placeholder) apart from "we've retried and it's still failing" (a `fetch_failed` placeholder with `revisionCount > 0`). See "Fetch timestamps and immutable history" below.

### Scanned, paper, and parse-failed filings

Older House PTRs were filed on paper and exist only as scanned images
— the PDF has no text layer, and `pdf-parse` returns nothing. There is
no OCR fallback. Rather than dropping these filings silently, each one
produces exactly one placeholder row: `politician`, `filing_date`,
`source_id`, and `pdf_url` are populated, `parse_status` is
`"scanned_unparsed"`, and every transaction-detail field
(`transaction_date`, `ticker`, `asset_name`, `asset_type`,
`asset_subtype`, `type`, `amount_min`, `amount_max`, `owner`) is `null`.

A second, distinct placeholder exists for a different failure mode:
`"parse_failed"`. Here the PDF *does* have a text layer and its
`[XX]` transaction markers *were* found — so it's not a scanned/paper
filing — but no transaction row matched the parser's expected
amount/date/type-code shape (e.g. an unrecognized amount format). This
signals a parser gap, not a known source-format limitation, and gets
the same placeholder treatment: same fields populated, same fields
null, `parse_status = "parse_failed"`.

A third placeholder, `"fetch_failed"`, covers a different layer
entirely: the PDF download itself failed after retries (network error,
timeout, non-2xx response), so the filing's content was never even
examined. Unlike the other two, this one is transient — the next
pipeline run that successfully fetches the same filing automatically
supersedes the placeholder with real rows (see "Coverage" above).

Filter all three out with `parse_status = "ok"`, or use `pdf_url` to go
read the filing yourself. In a recent 90-day sample (133 filings),
roughly 14% hit `scanned_unparsed`; `fetch_failed` and `parse_failed`
are expected to be rare (the former fires on transient network/host
issues, the latter only when a real filing exposes a parser gap) — each
`parse_failed` occurrence is a signal to add a fixture and extend the
parser, not a steady-state percentage like the scanned rate. Every
pipeline run logs and reports `fetchFailedCount` and `parseFailedCount`
(see the run's `OUTPUT` key-value record) so a spike or a new gap
doesn't go unnoticed.

### Duplicate transactions across filings

`id` is unique per row (it includes `source_id`), so rows never collide. But
the same real-world trade can appear in more than one source document — for
example a filing marked `Filing Status: Amended` that re-lists transactions
from the original. `content_hash` fingerprints only the trade's real-world
content — politician, date, asset, buy/sell, amount range, **owner** — with
`source_id` left out, so duplicate copies hash identically.

**Exact cross-filing duplicates are removed by default.** Within one run, if
rows from *different* filings (DocIDs) by the same filer share a
`content_hash`, one copy is returned: the one from a filing with an
`Amended` row if there is one, otherwise the later `filing_date`. This
happens **before** anything is written or charged, so removed duplicates are
never billed. Set `includeDuplicates: true` to keep every copy.

Not duplicates, and never touched:

- **Rows that differ in `owner`.** A filer who trades the same stock for
  themself *and* a spouse (or a joint account and a dependent) reports two
  lines with the same ticker, date and amount. Owner is part of the hash, so
  they are different rows. Run `IDgg2nQSlsPoPxJhr` (475 rows) had 15
  identical-looking pairs (Donalds, Franklin, …): 9 differed in owner.
- **Identical rows within one filing** (same `source_id` prefix, `house_<DocID>_`).
  Repeated line items of a single PTR — the other 6 pairs in that run.
  `row_index_in_filing` (0-based, source order) tells them apart. No
  pair in that run spanned two filings, so nothing there was a true
  duplicate.

Two fields record supersession where the data shows it. The House source has
no "amends filing X" link (and no amendment number — `amendment_number` is
always `null`), so:

- `supersedes_filing_id` — on an amended filing's rows: the `filing_id` of
  the earlier filing by the same filer that shares at least one identical trade.
- `is_superseded` — `true` on the surviving rows of that earlier filing.

Anything not shown by shared trades stays `null` / `false` — "not
determinable", not "not superseded". Duplicates **across runs** are
unaffected (runs never see each other's dataset): group by `content_hash` when
merging datasets.

### Fetch timestamps and immutable history

The House Clerk system can revise a PTR after it's first posted — the
Clerk refiles a corrected page, or a re-scan replaces a garbled PDF —
with nothing in the source flagging that it happened. `fetchedAt` and
`lastModifiedAt` exist so a revision is dateable instead of invisible.

- **`fetchedAt`** is set once, the first time a row is pulled, and
  never changes after that — not even across a revision.
- **`lastModifiedAt`** tracks when the row's content last changed. It
  equals `fetchedAt` until the source republishes the row with
  different content.
- **`revisionCount`** counts how many times that's happened.

Rows are never overwritten in place — a revision lands as a new row
(new `id`, since amount/date/asset feed the id's hash) that carries
`fetchedAt` forward from the prior version. Both stay in the dataset.

**How to use it:** keep a snapshot of a prior pull and diff it against
a fresh one. Where two rows share `source_id` but differ in
`content_hash`, `lastModifiedAt` tells you exactly when the value you
were relying on changed.

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

On first connection you'll be asked to sign in to Apify. Runs are billed to your Apify account at the normal pay-per-result price. On pay-per-event pricing every row written to the dataset is billed, placeholders included — a `fetch_failed`, `scanned_unparsed`, or `parse_failed` placeholder is written and billed like any other row (see "Coverage").

---

## How it works

```
   ZIP fetch         XML parse          PDF download       Text extract       Normalize
┌──────────────┐  ┌────────────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────┐
│ <YEAR>FD.zip │─▶│ <YEAR>FD.xml   │─▶│ /ptr-pdfs/    │─▶│  pdf-parse   │─▶│ buy/sell │
│ from         │  │ filter         │  │ <YEAR>/       │  │ + marker-    │  │ + amount │
│ disclosures- │  │ FilingType='P' │  │ <DocID>.pdf   │  │ anchored     │  │ ranges   │
│ clerk        │  │ + date window  │  │ (~600ms each) │  │ regex        │  │ + dates  │
└──────────────┘  └────────────────┘  └───────────────┘  └──────────────┘  └──────────┘
                                                                                 │
                                                                                 ▼
                                                                     ┌──────────────────┐
                                                                     │ Dedup (SHA-256)  │
                                                                     │ + Apify Dataset  │
                                                                     └──────────────────┘
```

**1. ZIP fetch.** A single HTTPS GET pulls the year-to-date ZIP from `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<YEAR>FD.zip`. No proxy or login needed — plain HTTPS.

**2. XML index.** Inside the ZIP is `<YEAR>FD.xml` listing every disclosure for the year. Filter to `FilingType=P` (Periodic Transaction Report) within the configured date window.

**3. Per-PTR PDF fetch.** Each XML entry has a `DocID`. Fetch `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/<YEAR>/<DocID>.pdf` for each one. Rate-limited to 600ms between requests.

**4. Text extraction.** `pdf-parse` reads the PDF and returns text. House PTRs are machine-generated so the text is clean — but the layout has quirks (header null bytes, glued fields, comment-block bleed).

**5. Marker-anchored parsing.** Each transaction row in the PDF includes a `(TICKER) [TYPE]` marker. The parser anchors on these markers, walks backward for the asset name, forward for the transaction details, and emits one record per marker.

**6. Normalize + dedup + push.** Map source codes (`P`/`S`/`S (partial)`, `SP`/`DC`/`JT`) to the canonical schema, hash the natural key (including `source_id`) for a stable per-row `id`, push to the default Apify dataset. A separate `content_hash` (source_id excluded) lets you spot the same real-world trade reported across two different PTR documents — see "Duplicate transactions across filings" above. A same-`source_id` row with a changed `content_hash` is logged as a revision and its `revisionCount`/`lastModifiedAt` updated — see "Fetch timestamps and immutable history" above.

Older filings filed on paper produce scanned-image PDFs that `pdf-parse` can't extract from. There is no OCR fallback, so the parser emits a `parse_status: "scanned_unparsed"` placeholder row for that filing instead of dropping it — see "Coverage" and "Scanned, paper, and parse-failed filings" above. In a recent 90-day sample (133 filings), roughly 14% hit this path. OCR fallback is on the Phase 2 list. A filing whose markers were found but whose row shape the parser doesn't recognize gets a separate `parse_status: "parse_failed"` placeholder instead, and a filing whose PDF download itself fails after retries gets a `parse_status: "fetch_failed"` placeholder that a later successful run automatically supersedes — same sections above.

---

## Apify deployment

The actor lives at [apify.com/seralifatih/congress-trading-pipeline-1](https://apify.com/seralifatih/congress-trading-pipeline-1).

To run it via API:

```bash
# Trigger a run
curl -X POST "https://api.apify.com/v2/acts/seralifatih~congress-trading-pipeline-1/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "fetchDaysBack": 30 }'

# Read the dataset
curl "https://api.apify.com/v2/datasets/<dataset-id>/items?token=YOUR_TOKEN&format=json"
```

### Input schema

| Field | Type | Default | Description |
|---|---|---|---|
| `fetchDaysBack` | `integer` | `90` | Rolling window of PTRs to fetch (1–365), counted back from today. See "Window" below |
| `fromDate` | `string` (YYYY-MM-DD) | — | Explicit start of the window. Overrides `fetchDaysBack` |
| `toDate` | `string` (YYYY-MM-DD) | today | Explicit end of the window |
| `members` | `string[]` | — | Only these House members. Case-insensitive; matches the normalized name **and nicknames**. See "Filters" below |
| `tickers` | `string[]` | — | Only transactions in these tickers (case-insensitive). Rows with no ticker are excluded |
| `transactionDateFrom` | `string` (YYYY-MM-DD) | — | Only trades executed on or after this date (inclusive) |
| `transactionDateTo` | `string` (YYYY-MM-DD) | — | Only trades executed on or before this date (inclusive) |
| `includeDuplicates` | `boolean` | `false` | Keep exact cross-filing duplicate rows instead of removing them |
| `debugPtrLimit` | `integer` | `0` | Diagnostic — fetch only the first N PTRs (newest first, after the `members` filter). Handy for a cheap test run |
| `debugPdfText` | `boolean` | `false` | Log first 2KB of any PDF where regex finds 0 rows |

Every field is optional; an empty input behaves as before.

### Window

**The window selects filings by *filing date*** — the `FilingDate` the House
Clerk's index records for each PTR — not by the date of the trades inside it.
Verified on run `IDgg2nQSlsPoPxJhr`: its rows had `filing_date` 2026-07-06 …
2026-09-25 while `transaction_date` spanned 2025-12-16 … 2026-09-15, because
members routinely file weeks or months after trading. Use
`transactionDateFrom`/`transactionDateTo` to select by trade date; they apply
**on top of** the filing-date window, so a trade is returned only if its filing
is inside the window too (widen `fetchDaysBack`/`fromDate` to catch late-filed
older trades — the run logs a warning when `transactionDateFrom` reaches back
past the window). A window that crosses New Year reads both calendar years'
index files.

That run had asked for `fetchDaysBack: 30` but received a 90-day window:
`fetchDaysBack` (and `debugPtrLimit`, and the hidden `enableOcr`) were
written to environment variables after the code had already read its
environment, so they were silently ignored. They are honoured as of this
version — see the CHANGELOG.

### Filters

All filters are applied **before anything is written or charged** — you are
never billed for a row a filter removed.

- **`members`** is applied to the Clerk's PTR **index**, before any PDF is
  downloaded: a non-matching member's PDFs are never fetched or parsed. An
  entry matches a filer when it resolves to the same member (`"Chuck
  Fleischmann"` matches `Charles J. "Chuck" Fleischmann`; `"Don Beyer"` matches
  `Donald Sternoff Beyer Jr`), when all of its name tokens appear in the filer's
  name after nickname normalization, or when it is a bioguide id (`P000197`).
  A bare last name matches every member with that last name. Member resolution
  uses the [congress-legislators](https://github.com/unitedstates/congress-legislators)
  roster — the same source and tiers the Senate actor uses, so both
  agree; if the download fails the run logs a warning
  and falls back to name-token matching.
- **`transactionDateFrom`** also prunes the index: a PTR can only report trades
  that already happened, so a filing filed before that date cannot contain a
  trade on or after it and its PDF is never downloaded. `transactionDateTo` has
  no such shortcut (a filing made today can report an old trade), so it is
  applied to each parsed row.
- **`tickers`** and the exact trade-date bounds need the parsed PDF, so they
  are applied row by row.
- When `tickers`, `transactionDateFrom` or `transactionDateTo` is set,
  **placeholder rows** (`fetch_failed`, `scanned_unparsed`, `parse_failed`)
  are not emitted — their content is unknown, so the filter can't be evaluated.
  They are counted as `placeholdersExcludedCount` in `RUN_SUMMARY`. A `members`
  filter alone keeps them (the filer is known).

### Charge cap behavior

- **Billing is per row written to the dataset.** The Actor's published pricing
  has one per-record event, **"Transaction record"** (the platform's
  `apify-default-dataset-item`), billed by the platform for every item written
  to the default dataset. The cap math in this actor uses exactly that price.
  The SDK offers no way to exempt individual rows from it (see CHANGELOG 1.6.0,
  "Investigated").
- **The cap stops the write, not the download.** When the run's maximum total
  charge is reached the actor stops *writing* rows (newest filings first, see
  above) — but it has already downloaded and parsed every PDF in the window, and
  that work is not skipped. At the current price that wasted work is cheap (on
  the order of $0.01–0.02 per 1,000 rows' worth of compute), so this is
  deliberate for now; narrow the window or use `members` to avoid it.
- A truncated run is reported in `RUN_SUMMARY` — see below.

### Processing order and the max charge (`RUN_SUMMARY`)

Filings are processed and written **newest filing first**. (The Clerk's index
is alphabetical by member; processing it in that order meant a run that stopped
early lost everyone late in the alphabet — in run `IDgg2nQSlsPoPxJhr` the output
ended at "Hern" and Pelosi never appeared.) If the run's **maximum total
charge** is reached, the run still ends `SUCCEEDED` — that is how the platform
behaves — but it no longer does so silently: the actor stops writing at the
cap, bills only what it wrote, logs a warning, sets the run's status message,
and writes a `RUN_SUMMARY` record to the run's key-value store:

```json
{
  "truncated": true,
  "reason": "max_total_charge_reached",
  "rowsEmitted": 475,
  "rowsNotEmitted": 125,
  "lastFilingDate": "2026-07-21",
  "lastFilingId": "…",
  "windowFrom": "2026-07-03",
  "windowTo": "2026-10-01"
}
```

`RUN_SUMMARY` is written on every successful run (`truncated: false`,
`reason: null` when nothing was cut). A truncated run is missing the *oldest*
filings; `lastFilingDate` is the filing date of the last row written (a filing
at the cap may be only partly written). To get the rest, raise the maximum
charge and/or narrow the window or filters — e.g. re-run with `toDate` set to
`lastFilingDate` (that day overlaps). `RUN_SUMMARY` also reports
`duplicatesCollapsed` (exact cross-filing duplicates removed before writing),
`placeholdersWithheld` (placeholder rows not emitted because a `tickers` or
transaction-date filter was set), `skippedByMemberCount`,
`skippedByTransactionDateCount`, `filteredByTickerCount` and
`filteredByTransactionDateCount`. (`duplicatesRemoved` and
`placeholdersExcludedCount` are the same two numbers under their earlier names.)

### Known limitations

- **Missing tickers.** About one row in ten has `ticker: null` with
  `asset_name` populated. In run `IDgg2nQSlsPoPxJhr` (468 parsed rows) the 44
  null-ticker rows were: 33 `Government Security` (Treasuries and municipal
  bonds — Beyer, Clark, Cohen, DelBene, Hern, …), 6 `Other` (private funds
  such as Oaktree / Blackstone vehicles, and two filers who typed a ticker as
  the whole asset name — `FAS`, `RSP ETF`), 3 `Corporate Bond`, and 2
  `Stock` (an Ellington preferred share, a private-company equity). The PDF
  gives no ticker for these; nothing is looked up or guessed (ticker enrichment
  is Phase 2). Part of the apparent null list was a real parse bug — see the
  owner-code note below.
- **Owner code glued to the asset name.** The PDF prints the owner column
  (`SP`/`DC`/`JT`) with no separator before the asset name. The parser strips
  it for "Word"-case names, and — as of this version — for all-caps and
  digit/dot/lowercase-leading names when the evidence is unambiguous (a ticker
  whose first letter matches the name without the code; or `JT` on a ticker-less
  row). A ticker-less all-caps row owned by a spouse or dependent child
  (`SPALPHAKEYS BLACKSTONE LIFE SCIENCES VI LP`) cannot be told apart from a
  name that really starts with `SP`/`DC` (`SPRINGFIELD…`, `DC WATER…`) and keeps
  its prefix with `owner: "self"`.
- **Names are as the Clerk's index prints them**, apart from collapsing a
  doubled token (the 2026 index has `First: "Scott Scott"` for Rep. Franklin and
  `"John John"` for another member). `politician_raw` is the original;
  `member_bioguide_id` is the canonical key for current House members and is
  `null` for anyone else or an ambiguous name.

---

## Self-hosting

If you'd rather run it yourself:

```bash
git clone https://github.com/seralifatih/congress-trading-pipeline
cd congress-trading-pipeline/house
npm install
cp .env.example .env
npm run build
node dist/apify.js   # or wire your own runner around runPipeline()
```

The pipeline's main export is in [`src/scheduler/pipeline.ts`](src/scheduler/pipeline.ts):

```ts
import { runPipeline } from './scheduler/pipeline.js';
import { SqliteStore } from './store/sqliteStore.js';

const stats = await runPipeline(SqliteStore.getInstance(), {
  fromDate: '2026-01-01',
  toDate: '2026-04-30',
});

console.log(stats); // { inserted, skipped, errors }
```

Storage is pluggable — `StoreAdapter` interface in [`src/types/index.ts`](src/types/index.ts). The repo ships with a SQLite implementation for local runs and an Apify Dataset implementation for cloud runs. Add Postgres or whatever else by implementing the same interface.

---

## Project layout

```
src/
├── apify.ts                  Actor entry point — wires runPipeline + ApifyStore
├── fetcher/
│   └── houseFetcher.ts       ZIP download + XML index + per-PDF fetch
├── parser/
│   └── housePdfParser.ts     Marker-anchored regex extractor
├── transformer/
│   └── normalize.ts          Source codes → canonical schema
├── store/
│   ├── sqliteStore.ts        Local SQLite via better-sqlite3
│   └── apifyStore.ts         Apify Dataset via Apify SDK
├── scheduler/
│   └── pipeline.ts           Fetch → parse → normalize → dedup → save
├── utils/
│   ├── config.ts             Zod-validated env vars
│   ├── dedup.ts              SHA-256 ID generation
│   ├── retry.ts              Exponential backoff with jitter
│   └── logger.ts             JSON-lines structured logger
└── types/
    └── index.ts              RawTransaction, Transaction, StoreAdapter, schemas
```

---

## Data source and permitted use

Data is sourced from public STOCK Act Periodic Transaction Reports published by the U.S. House Clerk and the U.S. Senate eFD system, and is provided for informational and research purposes.

Users are responsible for ensuring their use complies with 5 U.S.C. §13107(c), which prohibits obtaining or using these reports for any unlawful purpose; any commercial purpose other than by news and communications media for dissemination to the general public; determining an individual's credit rating; or soliciting money for political, charitable, or other purposes.

Not investment advice. Disclosures are filed up to 45 days after a trade and report amount ranges, not exact values.

This actor's source is the [Clerk of the U.S. House — Financial Disclosure Reports](https://disclosures-clerk.house.gov/FinancialDisclosure), published under the [STOCK Act of 2012](https://en.wikipedia.org/wiki/STOCK_Act). The Clerk publishes a fresh ZIP daily containing every disclosure filed that year. This pipeline does not scrape third-party aggregators. It pulls only from the official source.

---

## Phase 2

- **OCR fallback** for scanned PDFs (older paper filings)
- **Ticker enrichment** for bond/muni rows where the source omits the ticker

---

## License

The code is MIT-licensed. That license covers the code only; use of the data is governed by "Data source and permitted use" above.