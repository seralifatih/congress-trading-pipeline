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
- **Fintech developers** building portfolio tools, alert systems, or
  dashboards on top of STOCK Act data
- **Journalists and researchers** monitoring congressional trading
  patterns — no account, no paywall, raw government data
- **Quiver Quantitative / Capitol Trades users** who want the raw feed
  instead of a third-party UI

**Why this instead of Quiver or Capitol Trades?**
They aggregate from the same source — the Senate eFD system. This
actor pulls directly from it. No middleman, no subscription. You own
the feed.

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
| `type` | `'buy' \| 'sell'` | Normalized from source purchase/sale codes |
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
duplicates across overlapping runs are dropped; records land in the
default Apify dataset.

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

## Data source

[U.S. Senate Electronic Financial Disclosures (eFD)](https://efts.senate.gov)
— a public government database. Senate PTR filings are required under
the [STOCK Act of 2012](https://en.wikipedia.org/wiki/STOCK_Act) and
are public domain.

This actor does not scrape third-party aggregators. It pulls only
from the official source.

---

## License

MIT. Use the actor or the source however you want.