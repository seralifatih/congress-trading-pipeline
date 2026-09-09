# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/v1.1.0
[1.0.0]: https://github.com/seralifatih/congress-trading-pipeline/releases/tag/v1.0.0
