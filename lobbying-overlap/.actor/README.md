# Congress Lobbying × Trades Overlap

**Cross-reference US federal lobbying disclosures with Congressional stock trading disclosures — one auditable record per overlap.**

This actor joins two public disclosure systems that don't share keys: quarterly lobbying filings under the Lobbying Disclosure Act (LDA) and member stock transactions disclosed under the STOCK Act (PTR filings). It surfaces **same-quarter co-occurrence**: a member traded in sector X during a quarter in which sector X was the subject of lobbying activity — and, where the member sits on a committee with jurisdiction over that sector, it says so.

Every output row is traceable to specific filing IDs and source URLs. This is a records product: it reports what the filings say, in a form you can archive, query, and verify. It does not score, rank, or interpret.

> **An overlap is not a finding of wrongdoing.** Members of Congress trade securities and industries lobby Congress; both are legal, disclosed, and continuous. Co-occurrence within a quarter is a factual observation about two public datasets, nothing more. This actor makes no claim of causation and emits no trade recommendations.

Part of a set:
- **[House Trading Pipeline](https://apify.com/seralifatih/congress-trading-pipeline-1)** — House Clerk PTRs, feeds this actor's House trades.
- **[Senate Trading Pipeline](https://github.com/seralifatih/congress-trading-pipeline/tree/master/senate)** — Senate eFD PTRs, feeds this actor's Senate trades.

Source: [github.com/seralifatih/congress-trading-pipeline/tree/master/lobbying-overlap](https://github.com/seralifatih/congress-trading-pipeline/tree/master/lobbying-overlap)

---

## What it produces

One record per **(member, quarter, sector)** overlap — not one per trade, not one per filing. Each record bundles the full evidence on both sides:

```json
{
  "member_bioguide_id": "A000379",
  "member_name": "Mark Alford",
  "chamber": "house",
  "party": "R",
  "state": "MO",
  "quarter": "2026-Q1",
  "sector": "defense",
  "mapping_rule_id": "tk:LMT->defense",
  "mapping_confidence": "high",
  "overlap_type": "committee_match",
  "disclosure_lag_days": 30,
  "trades": [
    {
      "ptr_filing_id": "4d6016b4...",
      "ptr_url": "https://disclosures-clerk.house.gov/...",
      "ticker": "LMT",
      "transaction_type": "purchase",
      "amount_range": "$1,001 - $15,000",
      "transaction_date": "2026-01-05",
      "disclosure_date": "2026-02-04"
    }
  ],
  "lobbying": [
    {
      "lda_filing_uuid": "7866327b-c892-4430-b9f0-1f0f679c58c6",
      "lda_url": "https://lda.gov/api/v1/filings/7866327b-.../",
      "registrant": "Example Government Affairs LLC",
      "client": "Example Defense Corp",
      "issue_codes": ["DEF", "BUD"],
      "amount_reported": 240000.0
    }
  ],
  "lobbying_filing_count": 38,
  "committees": [
    {
      "committee_id": "HSAS",
      "committee_name": "House Committee on Armed Services",
      "jurisdiction_tags": ["defense", "aerospace"],
      "is_subcommittee": false,
      "role": "Member"
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `member_bioguide_id` | `string` | Bioguide ID from `unitedstates/congress-legislators` |
| `member_name` | `string` | Current official full name |
| `chamber` | `'house' \| 'senate'` | |
| `party` | `'D' \| 'R' \| 'I'` | |
| `state` | `string` | Two-letter USPS code |
| `quarter` | `string` | `YYYY-QN`, derived from trade date |
| `sector` | `string` | Crosswalk sector vocabulary, e.g. `defense`, `healthcare` |
| `mapping_rule_id` | `string` | Which crosswalk rule fired, e.g. `tk:LMT->defense` — always traceable |
| `mapping_confidence` | `'high' \| 'medium' \| 'low'` | Confidence of the strongest rule that produced this record |
| `overlap_type` | `'committee_match' \| 'sector_match_only'` | See below |
| `disclosure_lag_days` | `integer` | Days from earliest trade's transaction date to its disclosure date |
| `trades[]` | `array` | Every trade by this member in this sector/quarter, each traceable to a PTR filing |
| `lobbying[]` | `array` | Lobbying filings in this sector/quarter, capped to the largest by reported amount |
| `lobbying_filing_count` | `integer` | Uncapped total — if greater than `lobbying.length`, the list was truncated |
| `committees[]` | `array` | Committee assignments that produced a `committee_match`; empty for `sector_match_only` |

### `overlap_type`

- **`committee_match`** — the member sits on at least one committee whose jurisdiction covers the overlap sector. The matched committee assignments are included as evidence.
- **`sector_match_only`** — the sector overlap exists, but no committee link does.

LDA filings disclose which chamber or agency was lobbied, not which committee — so committee matching is resolved through sector jurisdiction, and the record shows exactly which committee and which jurisdiction tag produced the match.

---

## How it works

```
   Parallel fetch                    Adapt              Join (pure)         Output
┌────────────────────┐          ┌──────────────┐    ┌───────────────┐  ┌──────────────┐
│ congress-legislators│         │ Name → member │    │ trades ×      │  │ Dataset      │
│ House/Senate trade  │────────▶│ resolution    │───▶│ filings on    │─▶│ + RUN_SUMMARY│
│ actors (Apify API)  │         │ Ticker/issue  │    │ (quarter,     │  │ (KV store)   │
│ LDA quarterly filings│        │ code mapping  │    │ sector)       │  │              │
└────────────────────┘          └──────────────┘    └───────────────┘  └──────────────┘
```

**1. Parallel fetch.** Reads the latest successful dataset of the House and/or Senate trading pipeline actors via the Apify API, fetches lobbying filings for the requested quarters from the Senate LDA REST API, and loads the member/committee roster from `unitedstates/congress-legislators` (cached 30 days).

**2. Adapt.** House and Senate trade actors emit different field names — the adapter normalizes both into one `Trade` shape and resolves filer display names to bioguide IDs (exact match, then a first+last fallback that tolerates nicknames and middle names). Unresolved names are reported, never dropped.

**3. Crosswalk.** Every trade ticker and every LDA issue code is mapped onto a shared sector vocabulary via [`data/crosswalk.yaml`](https://github.com/seralifatih/congress-trading-pipeline/blob/master/lobbying-overlap/data/crosswalk.yaml) (ticker overrides, then a GICS-sector fallback for issue codes). Committee jurisdictions come from [`data/committee_jurisdictions.yaml`](https://github.com/seralifatih/congress-trading-pipeline/blob/master/lobbying-overlap/data/committee_jurisdictions.yaml). Every mapping carries a `confidence` grade and a `rule_id` that names exactly which row fired.

**4. Join (pure).** Trades and lobbying filings are grouped by `(member, quarter, sector)`. A record is emitted only when a member traded in a sector that had at least one lobbying filing that same quarter. Committee assignments are checked against the sector to decide `committee_match` vs `sector_match_only`.

**5. Output.** Records land in the default Apify dataset. Every run — including zero-overlap runs — also writes a `RUN_SUMMARY` to the key-value store: quarters covered, members scanned, overlap counts by type, and every unmapped issue code / ticker / committee / member name, so nothing is silently dropped.

All HTTP calls retry with exponential backoff; the LDA fetcher additionally paces requests against LDA's shared rate limit and honors `Retry-After`.

---

## The crosswalk is yours to audit

There is no official mapping between LDA issue codes, stock tickers, and committee jurisdictions. Every product in this space invents one — most keep it hidden. **This one ships in the open, in the repo, as hand-editable YAML:**

- [`data/crosswalk.yaml`](https://github.com/seralifatih/congress-trading-pipeline/blob/master/lobbying-overlap/data/crosswalk.yaml) — all 79 official LDA general issue codes → sectors, plus ticker → sector rules (explicit per-ticker overrides and a GICS-sector fallback)
- [`data/committee_jurisdictions.yaml`](https://github.com/seralifatih/congress-trading-pipeline/blob/master/lobbying-overlap/data/committee_jurisdictions.yaml) — every current House, Senate, and joint committee → jurisdiction sectors

Every mapping row carries a `confidence` grade (`high` / `medium` / `low`), and every output record names the exact rule that fired (`mapping_rule_id`). If you disagree with a mapping, you can see it, trace it, and change it — the run summary also lists every issue code, ticker, and committee the crosswalk could **not** resolve.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LDA_API_KEY` | No | Senate LDA API key. Falls back to the `lda_api_key` actor input, then anonymous access (heavily rate-limited). Register a free key at [lda.gov](https://lda.gov) for reliable multi-quarter runs. Never logged — only whether a key was used. |
| `APIFY_TOKEN` | Yes (standalone only) | Needed to read the House/Senate trading pipeline actors' datasets via the Apify API when running outside the Apify platform. Not required when running as an actor on Apify — the platform provides dataset access natively. |

Copy `.env.example` locally if you add one for your own runs; none is checked in because both variables are optional or platform-provided. Never commit real key values.

---

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `quarters` | array | last completed quarter | Quarters to cover, e.g. `["2026-Q1"]` |
| `chambers` | array | `["house", "senate"]` | Which chambers to scan |
| `overlap_types` | array | both | Filter to `committee_match` and/or `sector_match_only` |
| `lda_api_key` | secret | — | Optional. The actor ships with a shared key sufficient for typical runs. Provide your own free key from lda.gov for heavy multi-quarter backfills or guaranteed throughput. |
| `max_concurrency` | integer | `5` | Outbound API concurrency (clamped to 10 server-side) |
| `max_filings_per_record` | integer | `100` | Cap on the lobbying evidence list per record; `lobbying_filing_count` always shows the uncapped total |
| `lda_max_pages` | integer | — | Debug cap for cheap test runs |

---

## How to use

**Apify Console (no code):** open the actor, pick your quarters, run. Results land in the dataset; export as JSON, CSV, or Excel.

**API:**

```bash
curl -X POST "https://api.apify.com/v2/acts/seralifatih~congress-lobbying-trades-overlap/runs?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quarters": ["2026-Q1"], "chambers": ["house", "senate"]}'
```

**Scheduled:** lobbying data is quarterly by law. A quarterly schedule a few weeks after each LDA filing deadline (Jan 20, Apr 20, Jul 20, Oct 20) keeps a complete archive with four runs a year.

---

## Self-hosting

```bash
git clone https://github.com/seralifatih/congress-trading-pipeline
cd congress-trading-pipeline/lobbying-overlap
pip install -r requirements.txt
export APIFY_TOKEN=your_token       # needed to read the House/Senate actors' datasets
export LDA_API_KEY=your_key         # optional, avoids anonymous rate limits
python -m src
```

Run the join logic standalone against local JSON dumps (no tokens needed) via the source modules directly, e.g. `python -m src.sources.ptr --file house_items.json --out mapped.json` or `python -m src.sources.lda 2026-Q1 --out q.json`.

---

## Project layout

```
src/
├── main.py                     Actor entry point — fetch → adapt → join → dataset + RUN_SUMMARY
├── models.py                   Pydantic v2 output schema, strict validation
├── crosswalk.py                Crosswalk loader/resolver — issue codes, tickers, committees → sectors
├── overlap.py                  Pure join logic: trades × filings × committees → OverlapRecord
└── sources/
    ├── lda.py                  Senate LDA REST API client — paced, retried, rate-limit aware
    ├── legislators.py          Member/committee roster from unitedstates/congress-legislators
    └── ptr.py                  Adapter over the House/Senate trading pipeline actors' datasets
data/
├── crosswalk.yaml              LDA issue codes + tickers → sectors, hand-edited
└── committee_jurisdictions.yaml  Committees → jurisdiction sectors, hand-edited
tests/                          pytest suite mirroring src/
```

---

## Data sources

| Source | What it provides |
|---|---|
| [Senate LDA REST API](https://lda.gov) (`lda.gov`) | Quarterly lobbying filings: registrant, client, issue codes, reported amounts |
| [House](https://apify.com/seralifatih/congress-trading-pipeline-1) / [Senate](https://github.com/seralifatih/congress-trading-pipeline/tree/master/senate) trading pipeline actors | Member stock transactions from PTR filings |
| [`unitedstates/congress-legislators`](https://github.com/unitedstates/congress-legislators) | Member roster and committee membership (cached, refreshed monthly) |

All sources are official or community-maintained public records. This actor does not scrape third-party aggregators.

---

## Limitations

- Federal only. State-level lobbying is out of scope.
- Quarterly granularity — that is the resolution the LDA imposes; nothing here is or can be real-time.
- Sector mapping is inherently judgment-laden. The crosswalk exposes every judgment it makes (`mapping_rule_id`, `confidence`) so you can audit or override them, but no mapping of tickers and issue codes to sectors is beyond argument.
- Trades without a listed ticker (real estate, private funds, bonds) are excluded and counted in the run summary.

---

## Disclaimer

This actor republishes and cross-references public disclosure records. An overlap record documents that two disclosed activities occurred in the same quarter and sector — it is not evidence of impropriety by any person, and must not be presented as such. Nothing in this actor's output is investment, legal, or any other kind of advice.

---

## License

MIT. Use the actor or the source however you want.
