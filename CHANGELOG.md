# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Senate and House pipelines: `id` could collide for two genuinely distinct transactions that shared every hashed field (politician, transaction_date, asset_name, amount) — most commonly same-day, same-security purchases split into multiple line items in one filing. `dedupKey`/`generateId` now also include `source_id` (filing/report id + row ordinal), so every real transaction gets a unique id and none are dropped or merged.
- Senate HTML-fallback parser (`parser/htmlParser.ts`, used only when the primary structured-endpoint path returns empty): `source_id` was derived from content (politician+date+asset+amount) and so carried the same collision risk as the pre-fix `id`. Now derived from row ordinal, matching the primary parser and the House PDF parser. House's parser already used a row ordinal — no change needed there.

### Changed
- **Breaking: `id` values change for all historical records** in both Senate and House datasets, since the hash inputs changed. `id` is a derived field (SHA-256 of `politician|date|asset|amount|source_id`) recomputed on every run — it was never meant to persist as a foreign key across a hash-input change, but any consumer that cached or joined on `id` values from before this change will see new ids on next re-ingestion of that data. No underlying transaction data changed, and no customer-facing (Apify Dataset) data was ever incorrect: `SqliteStore` — the only store where the old `INSERT OR IGNORE` scheme could silently drop one of a colliding pair — is not in the Apify actor's output path (`dist/apify.js` uses `ApifyStore`/`Dataset.pushData` only; `SqliteStore` backs a separate, non-production self-hosted mode via `src/index.ts`).
- `Transaction` schema: `id` field corrected from `z.string().uuid()` to `z.string()` — it was always a sha256 hex digest, never a UUID; the stricter validator was unused dead-weight since `id` is assigned after schema validation, but would have rejected valid ids if ever re-validated.
- `Transaction` schema: `source_id` is now a required field (previously present only on the intermediate `RawTransaction`, dropped during normalization).
- SQLite schema (`transactions` table): added `source_id TEXT NOT NULL` column, plus an automatic migration in `SqliteStore`'s constructor — on connect, if a `transactions` table exists without a `source_id` column, it's dropped and recreated (this store is a rebuildable local dedup cache, not a system of record, so stale rows are discarded rather than backfilled; the next pipeline run re-ingests from source). No manual migration step required.

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

[1.0.0]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/v1.0.0
