# Congress Trading Pipeline

Two pipelines that pull U.S. congressional stock trading disclosures — required by the STOCK Act — directly from the official government sources and deliver clean, deduplicated JSON. No third-party aggregators, no subscription, public domain data.

---

## Two pipelines in this repo

### [`senate/`](./senate/README.md) — Senate Trading Pipeline

Fetches U.S. Senate Periodic Transaction Reports (PTRs) from the [Senate Electronic Financial Disclosures](https://efts.senate.gov) JSON API. Normalizes, deduplicates, and exposes a REST API. Runs on a 6-hour cron schedule.

Hosted actor: [apify.com/seralifatih/congress-trading-pipeline](https://apify.com/seralifatih/congress-trading-pipeline)

### [`house/`](./house/README.md) — House Trading Pipeline

Fetches U.S. House PTRs from the [Clerk of the House](https://disclosures-clerk.house.gov/FinancialDisclosure) year-to-date ZIP archive, downloads each filing's PDF, and parses transactions using marker-anchored regex. Pushes to an Apify dataset.

Hosted actor: [apify.com/seralifatih/congress-trading-pipeline-1](https://apify.com/seralifatih/congress-trading-pipeline-1)

---

## Schema differences

The two pipelines emit slightly different field names. If you consume both, map accordingly:

| Concept | Senate field | House field |
|---|---|---|
| Transaction type | `trade_type` | `type` |
| Amount lower bound | `amount_low` | `amount_min` |
| Amount upper bound | `amount_high` | `amount_max` |
| Midpoint | `amount_midpoint` | *(not emitted)* |
| Filer name | `filer_name` | `politician` |

A unified cross-chamber schema is on the Phase 2 list.

---

## Quick start

```bash
git clone https://github.com/seralifatih/congress-trading-pipeline
```

**Senate pipeline**

```bash
cd congress-trading-pipeline/senate
npm install
cp .env.example .env   # all vars have defaults
npm run dev            # starts on http://localhost:3001, runs pipeline immediately
```

**House pipeline**

```bash
cd congress-trading-pipeline/house
npm install
cp .env.example .env
npm run build
node dist/apify.js     # or wire your own runner around runPipeline()
```

See each subfolder's README for full environment variable reference, API docs, and architecture details.

---

## Run it hosted

Both pipelines run as Apify actors — managed, scheduled, no server to maintain.

| Actor | Source | Apify Store |
|---|---|---|
| Senate Trading Pipeline | Senate EFD JSON API | [apify.com/seralifatih/congress-trading-pipeline](https://apify.com/seralifatih/congress-trading-pipeline) |
| House Trading Pipeline | House Clerk ZIP + PDF | [apify.com/seralifatih/congress-trading-pipeline-1](https://apify.com/seralifatih/congress-trading-pipeline-1) |

Run either or both. The hosted versions update automatically — no infrastructure, no cron to manage. Self-hosting gives you full control over scheduling, storage, and the REST API layer; the hosted feed gives you zero-maintenance JSON you can query via the Apify API.

---

## Data source

- Senate: [U.S. Senate Electronic Financial Disclosures](https://efts.senate.gov) — PTRs required under the STOCK Act of 2012
- House: [Clerk of the U.S. House — Financial Disclosure Reports](https://disclosures-clerk.house.gov/FinancialDisclosure) — same legal requirement, different filing system

All data is public domain U.S. government disclosure data. These pipelines do not scrape third-party aggregators.

---

## License

MIT
