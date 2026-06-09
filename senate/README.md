# Congress Trading Pipeline — API

A Senate committee member files a purchase of $500k–$1M in a defense contractor — two weeks before a major contract announcement.
Three days later it's on Reddit. Two weeks later it's on the news.

This pipeline delivers that filing — and every other Senate PTR — as clean JSON, within 24 hours of the official disclosure.

Ingests U.S. Senate Periodic Transaction Reports (PTRs) directly from the Senate Electronic Financial Disclosures office, normalizes them, and exposes a JSON API compatible with the existing frontend — replacing the QuiverQuant dependency entirely.

No third-party data vendor required. No scraping. Source is public domain U.S. government disclosure data.

## Who uses this

- **Traders** following Senate insiders — Pelosi trades, Warren buys, defense committee members moving before contract announcements
- **Algo traders** who want structured JSON they can pipe directly into a strategy without manual CSV parsing
- **Data engineers** who need a clean, deduplicated Senate trading feed with stable record IDs for joins and incremental loads
- **App developers** who want a drop-in API endpoint — run on Railway/Render, point your frontend at /api/transactions

**Why this instead of existing tools?**
Senate EFD data is publicly available but awkward to consume. This pipeline normalizes the raw filings into a consistent schema with stable IDs, dedup, and a queryable REST API — so you build on top, not around.

---

## Prerequisites

- Node.js 18+
- No external services, databases, or API keys required for MVP

---

## Setup

```bash
npm install
cp .env.example .env   # edit as needed — all vars have defaults
npm run dev
```

Server starts on `http://localhost:3001`.  
On first boot the scheduler runs the pipeline immediately, then every 6 hours.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP listen port |
| `DB_PATH` | `./data/pipeline.db` | SQLite file path (created automatically) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `NODE_ENV` | `development` | Set to `production` for JSON-lines log output |
| `CRON_SCHEDULE` | `0 */6 * * *` | node-cron schedule expression |
| `FETCH_DAYS_BACK` | `90` | Rolling window of PTRs to fetch |
| `CRON_SECRET` | *(empty)* | Shared secret for `/api/cron` and `/api/sync-committees` |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Allowed CORS origin when running standalone |
| `LAST_RUN_PATH` | `./data/last_run.json` | Persisted last-run stats file |

---

## Pipeline architecture

```
┌──────────┐   ┌──────────┐   ┌─────────────┐   ┌────────┐   ┌────────┐
│  Fetch   │──▶│  Parse   │──▶│  Transform  │──▶│  Dedup │──▶│ Store  │
│          │   │          │   │             │   │        │   │        │
│ Senate   │   │ JSON     │   │ type        │   │ key:   │   │ SQLite │
│ EFD API  │   │ primary  │   │ amount      │   │ name + │   │ INSERT │
│ GET      │   │          │   │ dates       │   │ date + │   │ OR     │
│ 100/page │   │ HTML     │   │ owner       │   │ asset +│   │ IGNORE │
│          │   │ fallback │   │ ticker      │   │ amount │   │        │
└──────────┘   └──────────┘   └─────────────┘   └────────┘   └────────┘
                                                                   │
                                                                   ▼
                                                           ┌──────────────┐
                                                           │  Express API │
                                                           │  :3001       │
                                                           └──────────────┘
```

**Source endpoint:** `GET https://efts.senate.gov/LATEST/search-index`  
**Pagination:** 100 records/page, loops until `hits.total` exhausted  
**Fallback:** if JSON parse yields empty `asset_name` on all rows, re-parses raw HTML  
**Retry:** 3 attempts with exponential backoff + ±25% jitter on all HTTP calls

---

## API reference

### `GET /health`

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "db_count": 847,
  "last_run": "2026-04-29T14:23:00.000Z"
}
```

---

### `GET /api/refresh`

Returns timestamp of most recently stored record. Called by the frontend on every page mount.

```bash
curl http://localhost:3001/api/refresh
```

```json
{ "lastUpdated": "2026-04-29T14:23:00.000Z" }
```

`lastUpdated` is `null` if no records exist yet.

---

### `POST /api/refresh`

Triggers a full pipeline run. Called when the user clicks "Refresh Data" in the frontend.

```bash
curl -X POST http://localhost:3001/api/refresh
```

```json
{ "ok": true, "signals": 14, "lastUpdated": "2026-04-29T14:23:00.000Z" }
```

On failure:

```json
{ "ok": false, "error": "Fetch failed: HTTP 503 Service Unavailable" }
```

---

### `GET /api/cron`

Same pipeline run as `POST /api/refresh`, protected by `CRON_SECRET`. Called by an external scheduler (Cloudflare Worker, cron job, etc.).

```bash
curl -H "x-cron-secret: your-secret" http://localhost:3001/api/cron
# or
curl "http://localhost:3001/api/cron?secret=your-secret"
```

```json
{
  "ok": true,
  "summary": {
    "ingested": 340,
    "newTrades": 14,
    "signalsGenerated": 14,
    "topScore": null,
    "topScoreTicker": null,
    "runAt": "2026-04-29T14:23:00.000Z"
  }
}
```

Returns `401` if secret is missing or wrong.

---

### `GET /api/sync-committees`

Syncs congressional committee membership. Protected by `CRON_SECRET`. Run once on setup, then weekly.

```bash
curl -H "x-cron-secret: your-secret" http://localhost:3001/api/sync-committees
```

```json
{ "ok": true, "synced": 0 }
```

---

### `GET /api/transactions`

Queryable read endpoint. Returns transactions serialized to match the frontend `Signal` field names.

```bash
# All recent transactions (default limit 500)
curl http://localhost:3001/api/transactions

# Filter by ticker
curl "http://localhost:3001/api/transactions?ticker=AAPL"

# Filter by politician (LIKE match, case-insensitive)
curl "http://localhost:3001/api/transactions?politician=Pelosi"

# Date range
curl "http://localhost:3001/api/transactions?date_from=2026-04-01&date_to=2026-04-30"

# Type + owner + pagination
curl "http://localhost:3001/api/transactions?type=buy&owner=joint&limit=50&offset=0"
```

```json
{
  "count": 2,
  "data": [
    {
      "id": "a3f...c1",
      "filer_name": "Nancy Pelosi",
      "filer_type": "congress",
      "trade_type": "purchase",
      "ticker": "NVDA",
      "asset_name": "NVIDIA Corporation",
      "asset_type": "Stock",
      "amount_low": 1000001,
      "amount_high": 5000000,
      "amount_midpoint": 3000000,
      "trade_date": "2026-04-29",
      "filing_date": "2026-04-29",
      "owner": "joint",
      "is_active": true
    }
  ]
}
```

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `politician` | string | Substring match (LIKE) |
| `ticker` | string | Exact match, auto-uppercased |
| `date_from` | YYYY-MM-DD | Inclusive lower bound on `transaction_date` |
| `date_to` | YYYY-MM-DD | Inclusive upper bound on `transaction_date` |
| `type` | `buy` \| `sell` | Exact match |
| `owner` | `self` \| `joint` \| `spouse` \| `child` | Exact match |
| `limit` | integer 1–1000 | Default 500 |
| `offset` | integer ≥ 0 | Default 0 |

Invalid params return `400`:

```json
{ "error": { "date_from": ["Must be YYYY-MM-DD"] } }
```

---

### `GET /api/debug`

Dev diagnostics. No auth. Returns DB count and 2 sample records.

```bash
curl http://localhost:3001/api/debug
```

---

## Cron schedule

Default: `0 */6 * * *` (every 6 hours).

Change via `CRON_SCHEDULE` env var — any valid [node-cron](https://github.com/node-cron/node-cron) expression.

```bash
CRON_SCHEDULE="0 */2 * * *" npm run dev   # every 2 hours
CRON_SCHEDULE="0 8 * * *" npm run dev     # once daily at 08:00
```

Last run stats (timestamp, inserted, skipped, errors) are persisted to `./data/last_run.json` after each run.

---

## Seeding and smoke test

Load 20 realistic fake records covering edge cases (null tickers, spouse/child owners, large amounts, same-day multi-trades, clusters):

```bash
npm run seed
```

Verify the running server responds correctly:

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run smoke
```

Smoke test exits 0 on all pass, 1 on any failure.

---

## Phase 2 roadmap

House of Representatives disclosures (efd.house.gov) use a different filing format and will be added after Senate coverage is stable. Planned additions: PDF parsing for older PTRs that lack structured data, ticker enrichment via OpenFIGI or a static CUSIP mapping table (resolving the `ticker: null` cases currently stored as-is), a scoring engine that ranks transactions by conviction signal (cluster detection, filing delay, filer track record), and Telegram/email alerts for high-score transactions. Multi-tenant auth (Supabase RLS + Paddle billing) is tracked separately under the SaaS roadmap.

---

## Data source

All data is sourced from the [U.S. Senate Electronic Financial Disclosures](https://efts.senate.gov) system — a public government database. Senate PTR filings are required under the STOCK Act and are public domain. This pipeline does not scrape third-party aggregators.
