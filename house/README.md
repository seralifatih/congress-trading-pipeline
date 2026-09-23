# U.S. House Trading Pipeline

Nancy Pelosi files a $500k–$1M purchase of Nvidia options.
Three days later it's on Reddit. Two weeks later it's on the news.

This pipeline delivers that filing — and every other House PTR —
as clean JSON, within 24 hours of the official disclosure.
No third-party aggregators. Direct from the Clerk of the House.

Part of a set:
- **[Senate Trading Pipeline](https://github.com/seralifatih/senate-trading-pipeline)** — same target schema, separate fetcher + PDF parser. Run either or both.
- **[Congress Lobbying × Trades Overlap](https://apify.com/seralifatih/congress-lobbying-trades-overlap)** — joins House + Senate trades with federal lobbying filings by member, quarter, and sector.

## Who uses this

- **Retail traders** tracking which Congress members are buying/selling
  before major legislation — defense stocks before NDAA votes, pharma
  before drug pricing bills, tech before antitrust hearings
- **Fintech developers** building portfolio tools, alert systems, or
  dashboards on top of STOCK Act data
- **Journalists and researchers** monitoring congressional trading
  patterns — no account, no paywall, raw government data
- **Quiver Quantitative / Capitol Trades users** who want the raw feed
  instead of a third-party UI

**Why this instead of Quiver or Capitol Trades?**
Both aggregate from the same source — the Clerk of the House. This
pipeline pulls directly from the official ZIP archive. No middleman,
no rate limits, no subscription. You own the pipeline.

---

## What it produces

One row per individual transaction reported in a House PTR:

```json
{
  "id": "4d6016b44239f646476ffac6798f21ae3e32c8ed75ea6c5b50a0bbdf9e5d3296",
  "politician": "Mark Alford",
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
| `politician` | `string` | Filer name as it appears on the PTR |
| `transaction_date` | `YYYY-MM-DD \| null` | Trade execution date. `null` on a `scanned_unparsed` placeholder row — see `parse_status` |
| `filing_date` | `YYYY-MM-DD` | Date the PTR was submitted to the House Clerk |
| `ticker` | `string \| null` | `null` for bonds, municipals, structured notes — also `null` on a `scanned_unparsed` placeholder row |
| `asset_name` | `string \| null` | Full asset description. `null` on a `scanned_unparsed` placeholder row |
| `asset_type` | `string \| null` | `Stock`, `Stock Option`, `Mutual Fund`, `Corporate Bond`, `Government Security`, etc. `null` on a `scanned_unparsed` placeholder row |
| `type` | `'buy' \| 'sell' \| 'exchange' \| null` | `Purchase` → `buy`; `Sale (Full)`/`Sale (Partial)` → `sell`; `Exchange` (asset type code `[E]` — e.g. shares received/surrendered in a merger) → `exchange`. `null` on a `scanned_unparsed` placeholder row |
| `amount_min` | `integer \| null` | Lower bound of reported amount range, USD. `null` on a `scanned_unparsed` placeholder row |
| `amount_max` | `integer \| null` | Upper bound. `null` for unbounded "Over $X" disclosures, and on a `scanned_unparsed` placeholder row |
| `owner` | `'self' \| 'joint' \| 'spouse' \| 'child' \| null` | Account owner per STOCK Act categories. `null` on a `scanned_unparsed` placeholder row |
| `source_id` | `string` | Source PTR's DocID + row ordinal (`house_<DocID>_<row_index>`), or `house_<DocID>_scanned` for a placeholder row |
| `content_hash` | `string` | SHA-256 of `politician\|date\|asset\|type\|amount_min\|amount_max\|owner` (source_id excluded) — see "Duplicate transactions across filings" below |
| `filing_type` | `'original' \| 'amendment' \| null` | Read from the PTR's own per-row "Filing Status: New/Amended" line. `null` only when that line is missing or unrecognized — never guessed from duplication. No amendment-number equivalent exists in this source (unlike Senate) |
| `parse_status` | `'ok' \| 'scanned_unparsed'` | `'ok'` for a normally-parsed row. `'scanned_unparsed'` means this filing's PDF has no extractable text layer (scanned/paper PTR, no OCR fallback) — see "Scanned and paper filings" below |
| `pdf_url` | `string` | The source House PTR PDF this row was parsed from (or, for a `scanned_unparsed` row, the PDF that couldn't be read) |
| `fetchedAt` | `string` (ISO 8601 UTC) | When this row was first pulled from source. Immutable — never updated by a later re-fetch of the same, unchanged row. See "Fetch timestamps and immutable history" below |
| `lastModifiedAt` | `string` (ISO 8601 UTC) | When this row's content last changed. Equal to `fetchedAt` until a revision is detected |
| `revisionCount` | `integer` | How many times this source row's content has changed since it was first seen. `0` if never revised |

### Scanned and paper filings

Older House PTRs were filed on paper and exist only as scanned images
— the PDF has no text layer, and `pdf-parse` returns nothing. There is
no OCR fallback. Rather than dropping these filings silently, each one
produces exactly one placeholder row: `politician`, `filing_date`,
`source_id`, and `pdf_url` are populated, `parse_status` is
`"scanned_unparsed"`, and every transaction-detail field
(`transaction_date`, `ticker`, `asset_name`, `asset_type`, `type`,
`amount_min`, `amount_max`, `owner`) is `null`. Filter these out with
`parse_status = "ok"`, or use `pdf_url` to go read the filing yourself.
In a recent 50-filing sample, roughly 12% of filings hit this path.

### Duplicate transactions across filings

`id` is unique per row (it includes `source_id`), so rows never
collide — but the same real-world trade can still appear under two
different ids if it's reported in more than one source document.
`content_hash` fingerprints only the trade's real-world content
(source_id excluded), so duplicate copies hash identically and you can
find them.

**We never drop or merge rows.** A shared `content_hash`:

- **Same document (same `source_id` prefix, `house_<DocID>_`):** a
  legitimate separate transaction — e.g. two same-day tranches of the
  same purchase. Keep both.
- **Different documents (different DocID):** the same trade reported
  more than once — e.g. a row later marked `filing_type: "amendment"`
  that re-lists a transaction from the original filing. Summing across
  both double-counts it — reconcile by `content_hash` before
  aggregating.

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

**1. ZIP fetch.** A single HTTPS GET pulls the year-to-date ZIP from `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<YEAR>FD.zip`. No proxy needed — plain HTTPS, no Akamai, no terms gate.

**2. XML index.** Inside the ZIP is `<YEAR>FD.xml` listing every disclosure for the year. Filter to `FilingType=P` (Periodic Transaction Report) within the configured date window.

**3. Per-PTR PDF fetch.** Each XML entry has a `DocID`. Fetch `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/<YEAR>/<DocID>.pdf` for each one. Rate-limited to 600ms between requests.

**4. Text extraction.** `pdf-parse` reads the PDF and returns text. House PTRs are machine-generated so the text is clean — but the layout has quirks (header null bytes, glued fields, comment-block bleed).

**5. Marker-anchored parsing.** Each transaction row in the PDF includes a `(TICKER) [TYPE]` marker. The parser anchors on these markers, walks backward for the asset name, forward for the transaction details, and emits one record per marker.

**6. Normalize + dedup + push.** Map source codes (`P`/`S`/`S (partial)`, `SP`/`DC`/`JT`) to the canonical schema, hash the natural key (including `source_id`) for a stable per-row `id`, push to the default Apify dataset. A separate `content_hash` (source_id excluded) lets you spot the same real-world trade reported across two different PTR documents — see "Duplicate transactions across filings" above. A same-`source_id` row with a changed `content_hash` is logged as a revision and its `revisionCount`/`lastModifiedAt` updated — see "Fetch timestamps and immutable history" above.

Older filings filed on paper produce scanned-image PDFs that `pdf-parse` can't extract from. There is no OCR fallback, so the parser emits a `parse_status: "scanned_unparsed"` placeholder row for that filing instead of dropping it — see "Scanned and paper filings" above. Roughly 12% of recent PTRs hit this path. OCR fallback is on the Phase 2 list.

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
| `fetchDaysBack` | `integer` | `90` | Rolling window of PTRs to fetch (1-365) |
| `fromDate` | `string` (YYYY-MM-DD) | — | Explicit start date. Overrides `fetchDaysBack` |
| `toDate` | `string` (YYYY-MM-DD) | today | Explicit end date |
| `debugPtrLimit` | `integer` | `0` | Diagnostic — fetch only first N PTRs |
| `debugPdfText` | `boolean` | `false` | Log first 2KB of any PDF where regex finds 0 rows |

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

## Data source

[Clerk of the U.S. House — Financial Disclosure Reports](https://disclosures-clerk.house.gov/FinancialDisclosure)

Public domain government records published under the [STOCK Act of 2012](https://en.wikipedia.org/wiki/STOCK_Act). The Clerk publishes a fresh ZIP daily containing every disclosure filed that year.

This pipeline does not scrape third-party aggregators. It pulls only from the official source.

---

## Phase 2

- **OCR fallback** for scanned PDFs (older paper filings)
- **Ticker enrichment** for bond/muni rows where the source omits the ticker
- ~~Cross-chamber merge actor~~ → shipped as [Congress Lobbying × Trades Overlap](https://apify.com/seralifatih/congress-lobbying-trades-overlap), which consumes both Senate + House datasets and joins them with LDA lobbying filings

---

## License

MIT. Use the actor or the source however you want.