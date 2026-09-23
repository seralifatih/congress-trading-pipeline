# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-09-23

### Fixed
- House API (`/api/transactions`, `/api/debug`) no longer returns `scanned_unparsed` placeholder rows, so the frontend never gets a `trade_type: null` Signal. The rows are still in the dataset and the SQLite store.

### Changed
- House actor bumped `0.4.0` → `0.4.1`. Senate is unchanged.

## [1.3.0] - 2026-09-23

### Fixed
- **Exchange transactions were silently dropped** on both actors. Senate `Exchange` and House `[E]` rows (e.g. shares received/surrendered in a merger) had no type mapping and were skipped as `unrecognized_type`. `type` now has a third value, `'exchange'`.
- **House rows with a wrapped amount range were silently dropped.** When the transaction data sat on the same line as the `[XX]` marker and the amount range wrapped a line break (`$15,001 -` / `$50,000`), the parser matched nothing. This most often hit `[GS]` bond rows, but stock rows too. In the 50 most recent House PTRs, 24 filings produced zero rows before this fix and 0 after (rows kept: 238 → 410).
- **Scanned/paper House PDFs were silently dropped.** A PDF with no text layer returned no rows, only a log line. Each such filing now produces one placeholder row (see `parse_status`). There is still no OCR.

### Added
- **`parse_status`** field (`'ok' | 'scanned_unparsed'`) on every row, both actors. Always `'ok'` on Senate, whose source is HTML.
- **`pdf_url`** field: the source PDF on House rows; always `null` on Senate.
- `npm test` in both actors (Node's built-in test runner, real PDF text fixtures).

### Changed
- **House consumers:** `transaction_date`, `ticker`, `asset_name`, `asset_type`, `type`, `amount_min`, `amount_max` and `owner` can now be `null`, but only on `scanned_unparsed` placeholder rows. Filter on `parse_status = "ok"` to keep the previous shape.
- The frontend-compatible API returns `trade_type: 'exchange'` for exchange rows (previously they could never appear) and `trade_type: null` for placeholder rows.
- SQLite schema: new `parse_status` and `pdf_url` columns, applied by the existing automatic migration.
- Both actors bumped `0.3.0` → `0.4.0`.

## [1.2.0] - 2026-09-16

### Added
- **`fetchedAt`** field (ISO 8601 UTC) on every Senate and House transaction: the timestamp this row was first pulled from source. Set once at insert and never overwritten by a later re-fetch of an unchanged row.
- **`lastModifiedAt`** field (ISO 8601 UTC): when this row's content was last observed to change. Equal to `fetchedAt` for a first-seen row.
- **`revisionCount`** field (integer, ≥0): how many times a source document/row has been observed to change content since it was first seen. `0` for a row that's never been revised.
- Revision detection: on each pipeline run, incoming rows are matched against prior rows by `source_id` (not by `id` or the dedup key — both change when content changes, so they can't detect a revision on their own). A `source_id` match with a different `content_hash` is logged as a revision; the new row carries `fetchedAt` forward from the prior version, sets `lastModifiedAt` to now, and increments `revisionCount`. Storage is append-only (Apify Datasets have no update-by-id API), so both the old and new versions of a revised row remain in the dataset — nothing is overwritten in place.
- SQLite schema: `fetchedAt`, `lastModifiedAt`, `revisionCount` columns (both packages), covered by the existing automatic old-schema migration — no manual step.
- Apify dataset schema (`dataset_schema.json`): added `fetchedAt`, `lastModifiedAt`, `revisionCount` field definitions and added them to the "full record" view.
- Both READMEs (repo + `.actor`): new "Fetch timestamps and immutable history" section explaining why the fields exist and how to diff a prior pull against a fresh one to date a source revision.

### Why
A source can revise an already-published filing (a corrected amount, a re-filed page) with no signal that it happened — the row just silently changes on the next fetch. `fetchedAt`/`lastModifiedAt`/`revisionCount` turn that from an invisible discrepancy into a dated one: a consumer diffing their own archive against a fresh pull can see not just that a row changed, but when.

### Changed
- Both actors bumped `0.2.0` → `0.3.0` (additive schema fields only — no changes to `id` or `content_hash` formulas).

## [lobbying-overlap 0.1.0] - 2026-09-09

### Added
- **`filing_type`** field (`'original' \| 'amendment' \| null`, same vocabulary as the Senate/House pipelines) on every `trades[]` item. Read straight through from the Senate/House pipeline dataset rows the actor already ingests — those rows have carried `filing_type` since pipeline `v0.2.0`/[1.1.0], but the overlap actor's adapter was dropping it silently on ingestion.
- **`amount_outlier`** field (boolean) on every `lobbying[]` item. LDA filings reporting `amount_reported >= $10,000,000` on a single LD-2 are far outside the normal range and look like source data-entry errors (observed: a $20,000,000 filing whose registrant/client string contains "STATE OF LOC NATION") — flagged, never dropped or zeroed, so a downstream spend total can choose to exclude them. Counted in `RUN_SUMMARY.lda_amount_outliers`.
- `.actor/dataset_schema.json`: added a `fields` type block (previously view-only) describing the full `OverlapRecord` shape, including `filing_type` and `amount_outlier` on the nested `trades[]`/`lobbying[]` items.

### Changed
- **Breaking: `disclosure_lag_days` can now be `null`.** It is nulled whenever the record's earliest trade has `filing_type: "amendment"` — an amendment can be filed long after the original PTR for reasons unrelated to disclosure timeliness (e.g. correcting an amount range), so the transaction-to-disclosure gap is not a meaningful lag and must not be emitted as if it were a late original filing. Previously every record emitted a non-negative integer here regardless of amendment status, which invited misreading multi-hundred-day amendment refilings as extreme late-disclosure violations.
- **Breaking: `lobbying_filing_count` renamed to `sector_lobbying_filing_count`.** No behavior change — naming fix only. The count (and the `lobbying[]` evidence list it describes) is sector-and-quarter-wide, not specific to the trade or trader in the record; the old name read as "filings related to this trade," which it never was (e.g. a PLTR overlap record's `lobbying[]` could include Drexel University and the Qatar embassy — both real filers in the `defense`/`aerospace` sector that quarter, neither connected to the trade itself).
- **Breaking: records whose strongest crosswalk rule is `mapping_confidence: "low"` are excluded from the dataset by default.** These were wrong often enough to be noise (e.g. AT&T → `media_entertainment`, Mastercard → `technology` via the GICS ticker fallback). The exclusion count is reported in the new `RUN_SUMMARY.low_confidence_excluded` field so it's visible, not silent.
- `RUN_SUMMARY`: added `low_confidence_excluded` and `lda_amount_outliers` counters.
- Actor version `0.0` → `0.1.0` (first versioned release of this actor).

## [1.1.0] - 2026-09-09

### Added
- **`content_hash`** field on every Senate and House transaction: SHA-256 of `politician|transaction_date|asset_name|type|amount_min|amount_max|owner`, deliberately excluding `source_id`. Unlike `id`, it's the same for the same real-world transaction no matter which source document reported it — the tool for spotting a trade disclosed twice (e.g. a duplicate filing, or an amendment that re-lists an original transaction). This is additive: it does not change how `id` is computed, and rows are never dropped or merged based on it — see each README's new "Duplicate transactions across filings" section for the rule and a worked example (Sen. McCormick's legitimate same-document tranches vs. Sen. Tuberville's cross-document duplicate filing).
- **`filing_type`** field (`'original' | 'amendment' | null`) on every Senate and House transaction, sourced from each filing's own label — never inferred from duplicate documents. Senate: read from the PTR detail page heading, which reads "... (Amendment N)" for an amendment and has no suffix for an original (also captured as a new **`amendment_number`** field, Senate-only — the House source has no equivalent sequence number). House: read from each transaction row's own "Filing Status: New/Amended" comment line — more granular than Senate, since House marks amendment status per row rather than per document. Neither source publishes a reference to which prior filing/row an amendment supersedes, so that relationship cannot be captured; `filing_type` is `null` wherever the source's label is missing or unrecognized.
- SQLite schema: `content_hash`, `filing_type` (both packages) and `amendment_number` (Senate) columns, covered by the existing automatic old-schema migration (see below) — no manual step.
- Apify dataset schema (`dataset_schema.json`): added `source_id`, `content_hash`, `filing_type`, and (Senate) `amendment_number` field definitions and added them to the "full record" view. `source_id` had been missing from this file since the previous release despite being a required `Transaction` field — also fixed here.

### Fixed
- Senate and House pipelines: `id` could collide for two genuinely distinct transactions that shared every hashed field (politician, transaction_date, asset_name, amount) — most commonly same-day, same-security purchases split into multiple line items in one filing. `dedupKey`/`generateId` now also include `source_id` (filing/report id + row ordinal), so every real transaction gets a unique id and none are dropped or merged.
- Senate HTML-fallback parser (`parser/htmlParser.ts`, used only when the primary structured-endpoint path returns empty): `source_id` was derived from content (politician+date+asset+amount) and so carried the same collision risk as the pre-fix `id`. Now derived from row ordinal, matching the primary parser and the House PDF parser. House's parser already used a row ordinal — no change needed there.

### Changed
- **Breaking: `id` values change for all historical records** in both Senate and House datasets, since the hash inputs changed. `id` is a derived field (SHA-256 of `politician|date|asset|amount|source_id`) recomputed on every run — it was never meant to persist as a foreign key across a hash-input change, but any consumer that cached or joined on `id` values from before this change will see new ids on next re-ingestion of that data. No underlying transaction data changed, and no customer-facing (Apify Dataset) data was ever incorrect: `SqliteStore` — the only store where the old `INSERT OR IGNORE` scheme could silently drop one of a colliding pair — is not in the Apify actor's output path (`dist/apify.js` uses `ApifyStore`/`Dataset.pushData` only; `SqliteStore` backs a separate, non-production self-hosted mode via `src/index.ts`).
- `Transaction` schema: `id` field corrected from `z.string().uuid()` to `z.string()` — it was always a sha256 hex digest, never a UUID; the stricter validator was unused dead-weight since `id` is assigned after schema validation, but would have rejected valid ids if ever re-validated.
- `Transaction` schema: `source_id` is now a required field (previously present only on the intermediate `RawTransaction`, dropped during normalization).
- SQLite schema (`transactions` table): added `source_id TEXT NOT NULL` column, plus an automatic migration in `SqliteStore`'s constructor — on connect, if a `transactions` table exists without a `source_id` column, it's dropped and recreated (this store is a rebuildable local dedup cache, not a system of record, so stale rows are discarded rather than backfilled; the next pipeline run re-ingests from source). No manual migration step required. This migration check now also covers `content_hash`, `filing_type`, and (Senate) `amendment_number`.
- Both actors bumped `0.1.0` → `0.2.0` (additive schema fields; `id`'s formula is unchanged from the prior fix in this same unreleased set).

<!--
## [Unreleased]

### Added
-

### Changed
-

### Fixed
-

### Removed
-
-->

## [1.0.0] - 2026-08-20

### Added
- Senate Trading Pipeline: fetches U.S. Senate Periodic Transaction Reports (PTRs) from the Senate Electronic Financial Disclosures system, normalizes and deduplicates them into clean JSON.
- House Trading Pipeline: fetches U.S. House PTRs from the Clerk of the House year-to-date ZIP archive, parses per-filing PDFs, and outputs the same canonical transaction schema.
- Congress Lobbying × Trades Overlap pipeline: joins House and Senate trade data with federal lobbying disclosures (LDA) by member, quarter, and sector.
- Hosted actors published on Apify: `congress-trading-pipeline` (Senate), `congress-trading-pipeline-1` (House), `congress-lobbying-trades-overlap`.

[1.3.1]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/v1.3.1
[1.3.0]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/v1.3.0
[1.2.0]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/v1.2.0
[lobbying-overlap 0.1.0]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/lobbying-overlap-v0.1.0
[1.1.0]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/v1.1.0
[1.0.0]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/v1.0.0
