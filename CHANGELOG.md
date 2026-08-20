# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
