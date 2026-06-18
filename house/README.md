# U.S. House Trading Pipeline

Nancy Pelosi files a purchase of $500k–$1M in Nvidia options.
Three days later it's on Reddit. Two weeks later it's on the news.

This pipeline delivers that filing — and every other House PTR — as clean JSON, within 24 hours of the official disclosure.

Fetches every U.S. House Periodic Transaction Report (PTR) directly from the official [Clerk of the House Financial Disclosure](https://disclosures-clerk.house.gov/FinancialDisclosure) ZIP archive, parses each filing's PDF, normalizes the rows, and pushes a clean transaction dataset to Apify.

Sister actor to the [Senate Trading Pipeline](https://apify.com/seralifatih/congress-trading-pipeline) — same data philosophy and source approach, separate fetcher + PDF parser. Note: the two actors currently emit slightly different field names (House uses `type`/`amount_min`/`amount_max`; Senate uses `trade_type`/`amount_low`/`amount_high`). A unified cross-chamber schema is on the Phase 2 list. Run either or both.

## Who uses this

- **Retail traders** tracking which Congress members are buying/selling before major legislation (defense stocks before NDAA votes, pharma before drug pricing bills, tech before antitrust hearings)
- **Fintech developers** building portfolio tools, alert systems, or dashboards on top of STOCK Act data
- **Journalists and researchers** monitoring congressional trading patterns — no account, no paywall, raw government data
- **Quiver Quantitative / Capitol Trades users** who want the raw feed instead of a third-party UI

**Why this instead of Quiver/Capitol Trades?**
Both aggregate from the same source — the Clerk of the House. This pipeline pulls directly from the official ZIP archive. No middleman, no rate limits, no subscription. You own the data pipeline.

**Public domain data. No third-party vendors. STOCK Act compliant.**

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
  "owner": "self"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | SHA-256 of `politician\|date\|asset\|amount_min\|amount_max` — stable dedup key |
| `politician` | `string` | Filer name as it appears on the PTR |
| `transaction_date` | `YYYY-MM-DD` | Trade execution date |
| `filing_date` | `YYYY-MM-DD` | Date the PTR was submitted to the House Clerk |
| `ticker` | `string \| null` | `null` for bonds, municipals, structured notes |
| `asset_name` | `string` | Full asset description |
| `asset_type` | `string` | `Stock`, `Stock Option`, `Mutual Fund`, `Corporate Bond`, etc. |
| `type` | `'buy' \| 'sell'` | `Purchase` → `buy`; `Sale (Full)`/`Sale (Partial)` → `sell` |
| `amount_min` | `integer` | Lower bound of reported amount range, USD |
| `amount_max` | `integer \| null` | Upper bound. `null` for unbounded "Over $X" disclosures |
| `owner` | `'self' \| 'joint' \| 'spouse' \| 'child'` | Account owner per STOCK Act categories |

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

**6. Normalize + dedup + push.** Map source codes (`P`/`S`/`S (partial)`, `SP`/`DC`/`JT`) to the canonical schema, hash the natural key for dedup, push to the default Apify dataset.

Older filings filed on paper produce scanned-image PDFs that `pdf-parse` can't extract from. The parser logs them as unparseable and continues — about 5% of historical PTRs. OCR fallback is on the Phase 2 list.

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
git clone https://github.com/seralifatih/house-trading-pipeline
cd house-trading-pipeline
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
- **Cross-chamber merge actor** that consumes both Senate + House datasets and emits a single Congress-wide stream with a unified schema.

---

## License

MIT. Use the actor or the source however you want.
