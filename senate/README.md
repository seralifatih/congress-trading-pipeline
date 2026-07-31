# U.S. Senate Trading Pipeline

Every U.S. Senate Periodic Transaction Report — the stock trades senators are legally required to disclose under the STOCK Act — delivered as clean, deduplicated JSON within hours of the filing hitting the official record. One row per transaction, with normalized buy/sell direction, integer dollar ranges, tickers, and stable IDs, so you can point a screener, an alerting rule, or a backtest straight at the dataset without writing a parser or reconciling a vendor's schema. Pulled directly from the Senate eFD system — no aggregator in the middle, no subscription, public domain data you own the feed for.

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
  "transaction_date": "2026-03-16",
  "filing_date": "2026-03-20",
  "ticker": "LMT",
  "asset_name": "Lockheed Martin Corporation",
  "asset_type": "Stock",
  "type": "buy",
  "amount_min": 250001,
  "amount_max": 500000,
  "owner": "self"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | SHA-256 of the natural key (`politician\|date\|asset\|amount`) — stable dedup key |
| `politician` | `string` | Filer name as it appears on the PTR |
| `transaction_date` | `YYYY-MM-DD` | Trade execution date |
| `filing_date` | `YYYY-MM-DD` | Date the PTR was submitted |
| `ticker` | `string \| null` | `null` for bonds, municipals, structured notes |
| `asset_name` | `string` | Full asset description |
| `asset_type` | `string` | `Stock`, `Stock Option`, `Mutual Fund`, `Corporate Bond`, etc. |
| `type` | `'buy' \| 'sell'` | `Purchase` → `buy`; `Sale (Full)`/`Sale (Partial)` → `sell` |
| `amount_min` | `integer` | Lower bound of reported amount range, USD |
| `amount_max` | `integer \| null` | Upper bound. `null` for unbounded "Over $X" disclosures |
| `owner` | `'self' \| 'joint' \| 'spouse' \| 'child'` | Account owner per STOCK Act categories |

Same schema as the House actor — records from both merge cleanly on
field names and dedup semantics.

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

**4. Dedup.** The natural key (`politician|date|asset|amount`) is
hashed to a stable SHA-256 ID, so re-running over an overlapping date
window will not produce duplicate rows.

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
| `fetchDaysBack` | `integer` | `90` | Rolling window of PTRs to fetch (1–365) |
| `fromDate` | `string` (YYYY-MM-DD) | — | Explicit start date. Overrides `fetchDaysBack` |
| `toDate` | `string` (YYYY-MM-DD) | today | Explicit end date |
| `debugPtrLimit` | `integer` | `0` | Diagnostic — fetch detail for only the first N PTRs |

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
- **Missing tickers.** Bonds, municipals, structured notes, and many
  non-equity assets carry no ticker in the source. Those rows have
  `ticker: null` with `asset_name` populated. Ticker enrichment is
  Phase 2.
- **Filer names are as-filed.** No canonical member ID, party, or
  committee data. Spelling and formatting follow whatever the filer
  submitted, so joining across chambers on name needs your own
  normalization.
- **Rows the source leaves blank.** An unparseable amount normalizes to
  `amount_min: 0`; an unparseable date drops the row rather than
  guessing. Both are logged.
- **Senate only.** House filings come from a different system with a
  different format — use the
  [House Trading Pipeline](https://apify.com/seralifatih/congress-trading-pipeline-1)
  for those.

---

## Data source

[U.S. Senate Electronic Financial Disclosures (eFD)](https://efts.senate.gov)
— a public government database. Senate PTR filings are required under
the [STOCK Act of 2012](https://en.wikipedia.org/wiki/STOCK_Act),
which obliges members of Congress to publicly report securities
transactions over $1,000 within 45 days. These records are public
domain.

This actor does not scrape third-party aggregators. It pulls only
from the official source.

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

MIT. Use the actor or the source however you want.
