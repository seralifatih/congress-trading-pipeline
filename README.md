# Congress Trading Pipeline

A Congress data suite that pulls U.S. congressional stock trading disclosures and federal lobbying disclosures — required by the STOCK Act and the Lobbying Disclosure Act, respectively — directly from the official government sources and delivers clean, deduplicated JSON, plus a records product that joins the two. No third-party aggregators, no subscription.

---

## Three pipelines in this repo

### [`senate/`](./senate/README.md) — Senate Trading Pipeline

Fetches U.S. Senate Periodic Transaction Reports (PTRs) from the [Senate Electronic Financial Disclosures](https://efts.senate.gov) JSON API. Normalizes, deduplicates, and exposes a REST API. Runs on a 6-hour cron schedule.

Hosted actor: [apify.com/seralifatih/congress-trading-pipeline](https://apify.com/seralifatih/congress-trading-pipeline)

### [`house/`](./house/README.md) — House Trading Pipeline

Fetches U.S. House PTRs from the [Clerk of the House](https://disclosures-clerk.house.gov/FinancialDisclosure) year-to-date ZIP archive, downloads each filing's PDF, and parses transactions using marker-anchored regex. Pushes to an Apify dataset.

Hosted actor: [apify.com/seralifatih/congress-trading-pipeline-1](https://apify.com/seralifatih/congress-trading-pipeline-1)

### [`lobbying-overlap/`](./lobbying-overlap/README.md) — Congress Lobbying × Trades Overlap

Joins quarterly federal lobbying filings (Lobbying Disclosure Act, via the `lda.gov` API) with the House and Senate trade data above, and surfaces same-quarter, same-sector overlaps between what members traded and what was being lobbied — with committee-jurisdiction matching where it applies. A records product: every row traces back to specific filing IDs and source URLs, and makes no claim of wrongdoing.

Hosted actor: [apify.com/seralifatih/congress-lobbying-trades-overlap](https://apify.com/seralifatih/congress-lobbying-trades-overlap)

---

## Schema differences

The Senate and House pipelines emit slightly different field names. If you consume both, map accordingly:

| Concept | Senate field | House field |
|---|---|---|
| Transaction type | `trade_type` | `type` |
| Amount lower bound | `amount_low` | `amount_min` |
| Amount upper bound | `amount_high` | `amount_max` |
| Midpoint | `amount_midpoint` | *(not emitted)* |
| Filer name | `filer_name` | `politician` |

A unified cross-chamber schema is on the Phase 2 list.

**`lobbying-overlap/` does not share this schema.** It reads both trade actors' output internally, normalizes it, and emits a different record shape — one row per `(member, quarter, sector)` overlap, bundling the matched trades and lobbying filings as evidence arrays rather than one row per transaction. See its [README](./lobbying-overlap/README.md#what-it-produces) for the output schema.

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

On first connection you'll be asked to sign in to Apify. Runs are billed to your Apify account at the normal pay-per-result price.

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

**Lobbying overlap pipeline**

```bash
cd congress-trading-pipeline/lobbying-overlap
pip install -r requirements.txt
export APIFY_TOKEN=your_token   # needed to read the House/Senate actors' datasets
python -m src
```

See each subfolder's README for full environment variable reference, API docs, and architecture details.

---

## Run it hosted

All three pipelines run as Apify actors — managed, scheduled, no server to maintain.

| Actor | Source | Apify Store |
|---|---|---|
| Senate Trading Pipeline | Senate EFD JSON API | [apify.com/seralifatih/congress-trading-pipeline](https://apify.com/seralifatih/congress-trading-pipeline) |
| House Trading Pipeline | House Clerk ZIP + PDF | [apify.com/seralifatih/congress-trading-pipeline-1](https://apify.com/seralifatih/congress-trading-pipeline-1) |
| Congress Lobbying × Trades Overlap | LDA API + both trade actors | [apify.com/seralifatih/congress-lobbying-trades-overlap](https://apify.com/seralifatih/congress-lobbying-trades-overlap) |

Run any combination. The hosted versions update automatically — no infrastructure, no cron to manage. Self-hosting gives you full control over scheduling, storage, and the REST API layer; the hosted feed gives you zero-maintenance JSON you can query via the Apify API. The overlap actor depends on the House and/or Senate actors' datasets, so it's most useful once at least one of those is already running (hosted or self-hosted).

---

## Data source and permitted use

- Senate: [U.S. Senate Electronic Financial Disclosures](https://efts.senate.gov) — PTRs required under the STOCK Act of 2012
- House: [Clerk of the U.S. House — Financial Disclosure Reports](https://disclosures-clerk.house.gov/FinancialDisclosure) — same legal requirement, different filing system
- Lobbying: [Senate Lobbying Disclosure Act (LDA) API](https://lda.gov) — quarterly LD-1/LD-2 filings required under the Lobbying Disclosure Act of 1995
- Member/committee roster: [`unitedstates/congress-legislators`](https://github.com/unitedstates/congress-legislators) — community-maintained, used by the overlap pipeline to resolve committee jurisdiction

These pipelines do not scrape third-party aggregators.

Data is sourced from public STOCK Act Periodic Transaction Reports published by the U.S. House Clerk and the U.S. Senate eFD system, and is provided for informational and research purposes.

Users are responsible for ensuring their use complies with 5 U.S.C. §13107(c), which prohibits obtaining or using these reports for any unlawful purpose; any commercial purpose other than by news and communications media for dissemination to the general public; determining an individual's credit rating; or soliciting money for political, charitable, or other purposes.

Not investment advice. Disclosures are filed up to 45 days after a trade and report amount ranges, not exact values.

---

## License

The code is MIT-licensed. That license covers the code only; use of the data is governed by "Data source and permitted use" above.
