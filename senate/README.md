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
  "owner": "self",
  "source_id": "257795ae-e1b2-411d-b562-8fe4c2a4f2a1|6",
  "content_hash": "7c2e5b8d4f6a0c9e3b7d1fa3f9c1e2b8d47f60a1c5e93b2d8f7a4c6e0b1d9f3a",
  "filing_type": "original",
  "amendment_number": null,
  "fetchedAt": "2026-03-20T18:04:11.000Z",
  "lastModifiedAt": "2026-03-20T18:04:11.000Z",
  "revisionCount": 0
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | SHA-256 of `politician\|date\|asset\|amount\|source_id` — unique per row, changes if source_id changes |
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
| `source_id` | `string` | The source PTR's document id plus the row's ordinal within it (`<ptr_uuid>\|<row_index>`) — identifies exactly which document and which line produced this row |
| `content_hash` | `string` | SHA-256 of `politician\|date\|asset\|type\|amount_min\|amount_max\|owner` — deliberately excludes `source_id`. See "Duplicate transactions across filings" below |
| `filing_type` | `'original' \| 'amendment' \| null` | Read from the PTR's own "(Amendment N)" label. `null` only when the source page didn't expose a label — never guessed from duplication |
| `amendment_number` | `integer \| null` | The N in "(Amendment N)". `null` for originals and for anything the source doesn't label |
| `fetchedAt` | `string` (ISO 8601 UTC) | When this row was first pulled from source. Immutable — never updated by a later re-fetch of the same, unchanged row. See "Fetch timestamps and immutable history" below |
| `lastModifiedAt` | `string` (ISO 8601 UTC) | When this row's content last changed. Equal to `fetchedAt` until a revision is detected |
| `revisionCount` | `integer` | How many times this source row's content has changed since it was first seen. `0` for a row that has never been revised |

Same core schema as the House actor — records from both merge cleanly
on field names and dedup semantics. `amendment_number` is Senate-only;
the House source has no equivalent sequence number (see its README).

### Duplicate transactions across filings

`id` is unique per row by construction (it includes `source_id`), so
two rows never collide — but that also means two rows describing the
*same real-world trade* can carry two different, permanently distinct
ids if the trade appears in more than one source document. This
happens in practice: Senate offices sometimes file the same PTR twice,
or file an amendment that re-lists a transaction from the original.

`content_hash` is how you detect that case. It fingerprints only the
transaction's real-world content — politician, date, asset, buy/sell,
amount range, owner — and deliberately leaves `source_id` out, so two
rows describing the same trade hash identically regardless of which
document or which row produced them.

**We never drop or merge rows for you.** A shared `content_hash` means
one of two things, and only you have the context to tell them apart:

- **Same document, shared `content_hash`:** a legitimate separate
  transaction — e.g. a spouse's structured note purchased in two
  same-day tranches, each its own line item. Keep both; this is not a
  duplicate.
- **Different documents, shared `content_hash`:** the same real-world
  transaction reported more than once — e.g. an original PTR and its
  amendment both listing the trade, or two accidental duplicate
  filings. A naive `SUM(amount)` across both rows double-counts.

**Worked example.** Sen. McCormick's PTR filed 2026-08-27 contains two
purchases of the same structured note on the same day, same amount
bracket — two different rows (`source_id` ending `|2` and `|3`) in the
*same* document, sharing a `content_hash`. Keep both; they are real,
distinct tranches.

By contrast, Sen. Tuberville's PTR filed 2024-10-29 exists as two
*separate* documents (`2b076d77-6bc1-4b67-8be9-8f45a787479f` and
`cce52b36-d00c-4710-a8ee-e84893fb4be1`), each containing the same 12
transactions. All 12 pairs share a `content_hash` across the two
`source_id` prefixes. Summing `amount_min`/`amount_max` over all 24
rows double-counts every trade — a consumer reconciling by
`content_hash` + distinct source document should count each trade once.

To group: `key = content_hash`, then inspect the `source_id` prefix
(everything before the last `|`) of each row in the group — same
prefix means same document (keep all), different prefixes mean
different documents (your call on which to count).

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
