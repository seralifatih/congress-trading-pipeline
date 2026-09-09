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
      "disclosure_date": "2026-02-04",
      "filing_type": "original"
    }
  ],
  "lobbying": [
    {
      "lda_filing_uuid": "7866327b-c892-4430-b9f0-1f0f679c58c6",
      "lda_url": "https://lda.gov/api/v1/filings/7866327b-.../",
      "registrant": "Example Government Affairs LLC",
      "client": "Example Defense Corp",
      "issue_codes": ["DEF", "BUD"],
      "amount_reported": 240000.0,
      "amount_outlier": false
    }
  ],
  "sector_lobbying_filing_count": 38,
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
| `mapping_confidence` | `'high' \| 'medium'` | Confidence of the strongest rule that produced this record. `low`-confidence records are excluded from the dataset entirely — see "Low-confidence mappings are excluded" below |
| `overlap_type` | `'committee_match' \| 'sector_match_only'` | See below |
| `disclosure_lag_days` | `integer \| null` | Days from the earliest trade's transaction date to its disclosure date. `null` when that trade is an amendment — see "Amendments and `disclosure_lag_days`" below |
| `trades[]` | `array` | Every trade by this member in this sector/quarter, each traceable to a PTR filing. Each item includes `filing_type` (`'original' \| 'amendment' \| null`, same vocabulary as the Senate/House pipelines) |
| `lobbying[]` | `array` | Lobbying filings for this sector/quarter — sector-wide, not specific to this trade (see "`sector_lobbying_filing_count`, not `lobbying_filing_count`" below), capped to the largest by reported amount. Each item includes `amount_outlier` |
| `sector_lobbying_filing_count` | `integer` | Uncapped total matching filings — if greater than `lobbying.length`, the list was truncated |
| `committees[]` | `array` | Committee assignments that produced a `committee_match`; empty for `sector_match_only` |

### `overlap_type`

- **`committee_match`** — the member sits on at least one committee whose jurisdiction covers the overlap sector. The matched committee assignments are included as evidence.
- **`sector_match_only`** — the sector overlap exists, but no committee link does.

LDA filings disclose which chamber or agency was lobbied, not which committee — so committee matching is resolved through sector jurisdiction, and the record shows exactly which committee and which jurisdiction tag produced the match.

### Amendments and `disclosure_lag_days`

Every trade in `trades[]` carries `filing_type` (`'original' | 'amendment' | null`) straight through from the Senate/House pipeline row it came from — same vocabulary those actors use, sourced from each filing's own label, never inferred from duplication.

An amendment can be filed long after the original PTR for reasons that have nothing to do with disclosure timeliness — most commonly, correcting an amount range or asset description. If `disclosure_lag_days` were computed from an amendment's dates, a routine correction filed 200 days after the original trade would read as a 200-day disclosure-lag violation, when the *original* filing may have been timely and only the correction was late. That is not a finding this actor is in a position to make, so it doesn't.

**The rule:** `disclosure_lag_days` is `null` whenever the record's earliest trade has `filing_type: "amendment"`. It is only ever a number when that trade is `"original"` or unlabeled (`null` — the source didn't say, which carries no particular suspicion). Consumers computing average or worst-case disclosure lag should filter to non-null values, not treat `null` as zero.

### Low-confidence mappings are excluded

The crosswalk's GICS-sector fallback (used when a ticker has no explicit override) is graded `high` / `medium` / `low` per rule, and `low`-confidence rules are wrong often enough to be noise rather than signal — e.g. AT&T mapping to `media_entertainment`, or Mastercard mapping to `technology`, purely because of their broad GICS sector classification. Records whose strongest matching rule is `low` confidence are **excluded from the dataset by default**; the count excluded is reported in `RUN_SUMMARY.low_confidence_excluded` so the exclusion is visible, never silent.

### `sector_lobbying_filing_count`, not `lobbying_filing_count`

`lobbying[]` and its count are **sector-and-quarter-wide**, not specific to the member's trade or the counterparties on the other side of it. A member who traded a defense stock will see every lobbying filing tagged to the `defense` sector that quarter — which can include registrants and clients with no connection to that trade at all (one real PLTR overlap record's `lobbying[]` included Drexel University, the Qatar embassy, and California water agencies, all legitimately lobbying on defense-adjacent issue codes that quarter). The field is named `sector_lobbying_filing_count` specifically so it can't be misread as "filings related to this trade."

### LDA amount outliers

A small number of LDA filings report implausibly large `amount_reported` values for a single LD-2 — most likely data-entry errors upstream (one observed filing reports **$20,000,000** with a registrant/client string containing "STATE OF LOC NATION"). These are never dropped or silently zeroed: any `lobbying[]` item with `amount_reported >= $10,000,000` carries `amount_outlier: true`, and the count seen in a run is reported in `RUN_SUMMARY.lda_amount_outliers`. A downstream consumer summing `amount_reported` for a spend total should filter out `amount_outlier: true` rows first.

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

**4. Join (pure).** Trades and lobbying filings are grouped by `(member, quarter, sector)`. A record is emitted only when a member traded in a sector that had at least one lobbying filing that same quarter, and only when the group's strongest crosswalk rule is `high` or `medium` confidence — `low`-confidence groups are excluded (see "Low-confidence mappings are excluded" above). Committee assignments are checked against the sector to decide `committee_match` vs `sector_match_only`. `disclosure_lag_days` is computed from the earliest trade in the group, and nulled if that trade is an amendment (see "Amendments and `disclosure_lag_days`" above).

**5. Output.** Records land in the default Apify dataset. Every run — including zero-overlap runs — also writes a `RUN_SUMMARY` to the key-value store: quarters covered, members scanned, overlap counts by type, low-confidence records excluded, LDA amount outliers flagged, and every unmapped issue code / ticker / committee / member name, so nothing is silently dropped.

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
| `max_filings_per_record` | integer | `100` | Cap on the lobbying evidence list per record; `sector_lobbying_filing_count` always shows the uncapped total |
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
