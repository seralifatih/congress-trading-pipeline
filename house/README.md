# House Trading Pipeline — API

Ingests U.S. House Periodic Transaction Reports (PTRs) directly from the official disclosures-clerk.house.gov ZIP archive, parses the per-filing PDFs, normalizes them, and emits a clean transaction dataset.

Sister project to [senate-trading-pipeline](https://github.com/seralifatih/congress-trading-pipeline). Same target schema, same store interface, separate fetcher + parser.

Public domain data. No third-party vendors.

---

## Pipeline

```
  ZIP download         XML parse           PDF fetch loop      Normalize
┌───────────────┐    ┌────────────┐      ┌──────────────┐    ┌──────────┐
│ <YEAR>FD.zip  │───▶│ <YEAR>FD.  │─────▶│ /ptr-pdfs/   │───▶│ buy/sell │
│ from          │    │ xml index  │      │ <YEAR>/      │    │ map +    │
│ disclosures-  │    │ (filter to │      │ <DocID>.pdf  │    │ amount   │
│ clerk         │    │ PTRs only) │      │ via pdf-parse│    │ ranges   │
└───────────────┘    └────────────┘      └──────────────┘    └──────────┘
                                                                    │
                                                                    ▼
                                                            ┌──────────────┐
                                                            │  Apify       │
                                                            │  Dataset     │
                                                            └──────────────┘
```

Filing types other than `P` (PTR) are filtered out at the index stage. Older scanned PDFs that pdf-parse can't extract are logged as unparseable and skipped (no failure) — OCR fallback is Phase 2.

---

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm run apify-start   # runs as Apify actor
```

---

## Apify deployment

1. Push this folder as its own GitHub repo
2. Apify Console → Create new actor → Link Git repository
3. Source folder: `.` (repo root)
4. Apify auto-detects `.actor/actor.json` and `Dockerfile`
5. Build → Run

---

## Data source

[U.S. House Clerk Financial Disclosure](https://disclosures-clerk.house.gov/FinancialDisclosure) — public government records under the STOCK Act.
