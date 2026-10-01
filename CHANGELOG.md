# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - Lobbying × Trades Overlap 0.2.0 (actor.json `0.1.0` → `0.2.0`)

Lobbying × Trades Overlap actor only. **Contains output-breaking changes** (vocabulary, field semantics) — treat as a major version for consumers. The House and Senate actors are unchanged.

### Changed (output-breaking)
- **`trades[].transaction_type` is now `buy | sell | exchange`**, matching the House/Senate trackers. It was `purchase | sale | exchange`. The adapter still accepts `purchase` / `sale` / `Sale (Full)` / `Sale (Partial)` on input.
- **`trades[].ptr_filing_id` is now the filing's own id** (the tracker's `filing_id`: House DocID, Senate filing UUID), not the tracker row's 64-char hash. The hash moved to the new **`trades[].tracker_row_id`**. Falls back to the row hash only when a tracker row has no `filing_id`.
- **`trades[].ptr_url` is the filing's own PDF on House rows** (the tracker's `pdf_url`) instead of the generic landing page. New **`trades[].ptr_url_kind`**: `document` | `portal_fallback`. Senate rows remain `portal_fallback` (the Senate tracker's `pdf_url` is null on parsed rows; no URL is synthesized — see README).
- Trades are attributed to members by the tracker's **`member_bioguide_id`** first; display-name matching is the fallback and is reported (`trades[].member_resolution`, `RUN_SUMMARY.member_resolution`, a log line per name). Previously every row was matched by name — e.g. "A. Mitchell McConnell, Jr." was unresolved.
- `trades[].filing_type` is matched case-insensitively. A `null` value means the tracker row stated no filing status (the House tracker sets it from each PTR row's own "Filing Status" line); it is passed through, never guessed. The adapter has no code path that nulls a recognised value, so a null in the output was null in the tracker row (the specific META row could not be checked: the tracker datasets are not readable from this environment).

### Added
- **`match_level: "sector"`** on every record, and an explicit statement in the README and actor description that matching is sector-level, not issuer-level.
- **`is_primary_mapping`** on each `trades[]` item and on each record, for multi-sector tickers (HD → retail + construction, JNJ → healthcare + pharma). Primary = strongest crosswalk rule (confidence, then `rule_id`). No rows are removed.
- **`lobbying[].amount_reported_status`** (`reported` | `not_applicable_registration` | `not_reported`), **`lobbying[].filing_type`** and **`lobbying[].filing_posted_date`**. `amount_reported` was null mostly because the actor includes LD-1 registrations (`RR`/`RA`), which have no income/expenses fields in the LDA API; parsing was correct (`Q2` reports populate `income`/`expenses`).
- `RUN_SUMMARY.member_resolution`, `RUN_SUMMARY.ptr_sources` (per-chamber rows read / mapped / skipped / unresolved / in-quarter) and `RUN_SUMMARY.ptr_skip_reasons`, so a chamber contributing zero records is explained rather than silent.

### Fixed
- **The actor no longer consumes whatever tracker run happened to be latest.** It previously read the most recent SUCCEEDED run of each tracker; a members-filtered test run (e.g. one senator, 2024–2025 trades) therefore made the overlap silently find nothing for the requested quarter. It now reads each candidate run's `RUN_SUMMARY` and `INPUT` and skips any run that is truncated, has any filter applied (`skippedByMemberCount`, `filteredByTickerCount`, `skippedByTransactionDateCount`, `filteredByTransactionDateCount`, `placeholdersWithheld`, or `members`/`tickers`/`transactionDateFrom`/`transactionDateTo` in its input), was debug-limited (`debugPtrLimit`), has no `RUN_SUMMARY` (pre-1.5 tracker — completeness can't be verified), or whose filing-date window doesn't cover the requested quarters. It walks back through the 15 most recent successful runs to the newest suitable one, and **fails the run loudly** (status message + error) if none qualifies. A window ending less than 45 days after the quarter only warns (late filings may be missing). **`RUN_SUMMARY.tracker_runs`** records, per chamber, the run id, dataset id, that run's own `RUN_SUMMARY`, and every newer run skipped with its reasons.
- The "largest amounts kept" cap now falls back to a deterministic order when amounts are null: most recently posted first, then `lda_filing_uuid`. Previously nulls were ordered by uuid alone.
- **LDA paging fetched only a fraction of the lobbying filings.** Anonymous access to the LDA API returns 25 results per page, but paging assumed 100, so roughly 75% of lobbying filings were never fetched. **All previous output from anonymous-access runs was incomplete** (lobbying evidence and `sector_lobbying_filing_count` undercounted; some overlaps may be missing). The page count now comes from the size of the first page actually returned. Not verified: the page size the API returns when a key is used.

## [1.5.0] - 2026-10-01

Both actors bumped `0.5.0` → `0.6.0`; the Lobbying × Trades Overlap actor is unchanged. **Highlights:** optional `members` / `tickers` / `transactionDateFrom` / `transactionDateTo` filters, applied before anything is fetched or charged; `fetchDaysBack` and `debugPtrLimit` finally honoured (they were silently ignored on Apify); a machine-readable `RUN_SUMMARY` that flags when a run was cut short by its maximum charge; exact cross-filing duplicates removed; new `politician_raw`, `member_bioguide_id`, `row_index_in_filing`, `supersedes_filing_id` / `is_superseded` fields; ticker, owner-code and wrapped-description parse fixes. **Billing correction:** placeholder rows are billed as normal "Transaction record" events — the 1.4.0 notes said they were free. No pricing or event changes.

### Senate actor (0.6.0)

Senate actor only (`0.5.0` → `0.6.0`). The House and Lobbying Overlap actors are unchanged. No pricing or charge-event changes. Every new input is optional and defaults to the previous behavior; the bug fixes under **Fixed** change output and are listed individually.

#### Added
- **Filters (all optional).** `members` (case-insensitive; matches the normalized name *and* nicknames — `"Tommy Tuberville"` matches `"Thomas H Tuberville"`; a bioguide id or a bare last name also works), `tickers`, `transactionDateFrom`, `transactionDateTo` (inclusive, YYYY-MM-DD). `members` and `transactionDateFrom` are applied against the filing list **before** each filing's detail page is fetched (a filing filed before `transactionDateFrom` cannot contain a later trade); `tickers` and the exact trade-date bounds are applied to parsed rows. All filters run before anything is written or charged. When `tickers` or a trade-date filter is set, placeholder rows (content unknown) are not emitted; they are counted in `RUN_SUMMARY.placeholdersExcludedCount`.
- **`includeDuplicates`** input (default `false`) to opt out of duplicate removal — see **Fixed**.
- **`politician_raw`** (the filer name exactly as listed) and **`member_bioguide_id`** (resolved from the same congress-legislators roster the Lobbying × Trades Overlap actor uses; `null` when the filer isn't a current senator or the name is ambiguous — never guessed) on every row.
- **`supersedes_filing_id`** / **`is_superseded`** on every row. The Senate source has no "amends filing X" link, so they are set only where the data shows it: an amendment and a lower-ranked filing by the same filer sharing at least one identical trade. Otherwise `null` / `false` (not determinable). `filing_type` / `amendment_number` are unchanged.
- **`RUN_SUMMARY`** key-value record on every successful run: `{ truncated, reason, rowsEmitted, rowsNotEmitted, lastFilingDate, lastFilingId, windowFrom, windowTo, … filter/duplicate counters }`. `truncated: true` means the run's maximum total charge stopped the dataset write short; the run also logs a warning and sets its status message. `OUTPUT` gains the same counters.
- **`received_ticker`** and **`received_asset_name`** on every row (non-null on Exchange rows only), and **`ticker` on an Exchange row is now the GIVEN asset's** — see **Fixed**.
- **`row_index_in_filing`** (0-based, source order, deterministic) on every row, so identical rows inside one filing (which share a `content_hash`) can be told apart. `0` on a placeholder. It is not part of `id` or `content_hash`; both are unchanged for every existing row (tested against the real Wyden row's old `id`/`content_hash`).
- `RUN_SUMMARY.placeholdersWithheld` (placeholders not emitted because a `tickers` / transaction-date filter was set) and `RUN_SUMMARY.duplicatesCollapsed` (exact cross-filing duplicates removed). The earlier `placeholdersExcludedCount` / `duplicatesRemoved` keys carry the same values and are kept.
- Tests for each change (`filters`, `dedupCollapse`, `budget`, `normalizeFixes`); 36 → 115.

#### Fixed
- **`fetchDaysBack` and `debugPtrLimit` were silently ignored on Apify.** The actor wrote them to `process.env` after the config and fetcher modules had already read the environment at import time, so every run used the 90-day default and no PTR cap. Reproduced: `fetchDaysBack: 30` on 2026-10-01 returned filings back to 2026-08-05 — a 90-day window (from 2026-07-03) cut short by the charge cap. Both are now passed to the pipeline explicitly. **Output change:** runs that set `fetchDaysBack` below 90 now return fewer, correctly-windowed rows. The window has always been, and is now documented as, a **filing-date** window (the Senate search is queried by submission date); trade-date selection is the new `transactionDateFrom`/`transactionDateTo`.
- **Silent truncation at the max-charge cap.** The SDK trims what it writes when the cap is reached and the run still ends `SUCCEEDED`; nothing said so (316 rows = (1 − 0.05) / 0.003). The actor now computes what the remaining budget covers before writing, writes exactly that (newest filings first), bills only what it wrote, and reports the shortfall in `RUN_SUMMARY`. Verified API: `ChargeResult { eventChargeLimitReached, chargedCount, chargeableWithinLimit }` and `ChargingManager.getPricingInfo()` / `getChargedEventCount()` in `apify@3.7.0`.
- **Exact cross-filing duplicates are now removed by default.** Rows from different filings by the same filer with an identical `content_hash` (e.g. an original PTR and the Amendment that re-lists it) are returned once, from the highest-ranked filing (higher `amendment_number`, then later `filing_date`) — an amendment's rows are never the ones removed. Measured on the 316-row run: 17 duplicate rows (Boozman original + Amendment 1, Tuberville Amendment 1 + 2). Rows that differ in any hashed field are kept; identical rows within a single filing are kept (legitimate tranches). **Output change:** fewer rows, and fewer billed rows, on windows that contain amended filings. `includeDuplicates: true` restores the old behavior. Cross-run duplicates are unaffected (runs don't see each other's datasets).
- **`scanned_unparsed` placeholders had a raw `MM/DD/YYYY` `filing_date` and an ALL-CAPS name.** Now ISO `YYYY-MM-DD` and re-cased (`RICHARD BLUMENTHAL` → `Richard Blumenthal`, `politician_raw` keeps the original) like parsed rows. Any ALL-CAPS name on any row is re-cased the same way; mixed-case names are untouched. Row `id`s are unaffected.
- **Exchange rows no longer put the RECEIVED ticker in `ticker`.** Wyden's PTR `5ecc9b5c…` has `asset_name` `BERY - Berry Global Group, Inc. (Exchanged) Amcor plc Ordinary Shares (Received)` and ticker cell `-- AMCR` (no given ticker, received `AMCR`). The ticker cell is "given received"; the first build of this release (and earlier versions' fallback) surfaced `AMCR` next to a `BERY` asset name, which was misleading and made a `tickers: ["BERY"]` filter miss the row. Now `ticker` = the given asset's (`BERY`, from the cell's first slot or a ticker the name text states), `received_ticker` = `AMCR`, `received_asset_name` = `Amcor plc Ordinary Shares`. `asset_name`, `id` and `content_hash` are unchanged. **Output change:** `ticker` on Exchange rows whose cell held a received ticker.
- **Dirty tickers.** `"-- AMCR"` → `AMCR` (artifact stripped) on ordinary rows; on **Exchange** rows see the next bullet. `COLPAL` (a company-name abbreviation, > 5 letters) → `null`, `asset_name` kept. `ROLLS` was never in the source — the ticker cell was `--` and the fallback extractor read the hyphen in `ROLLS-ROYCE HOLDINGS PLC ADR` as a `"XXXX - Company"` delimiter; that pattern now requires whitespace before the dash (`EA - Electronic Arts` still extracts), so those rows are `null`. A ticker cell with several tickers is ambiguous → `null`. No ticker is ever looked up or guessed.

#### Changed
- **README billing claim corrected (both READMEs).** Placeholder rows (`fetch_failed`, `scanned_unparsed`, `parse_failed`) are billed as a normal "Transaction record" event, like any row written to the default dataset: the Actor's only priced per-record event is the platform's `apify-default-dataset-item`, which the platform bills for every default-dataset write, and the Actor cannot exempt individual rows. The "Billed? No" / "written for free" statements (introduced in 1.4.0 as a "pay-per-event billing gate") were wrong and are removed. No pricing, event or output change — placeholders are still written to the default dataset.
- **Removed the dead `Actor.charge('transaction')` call.** `transaction` is not a registered event, so it only logged an "unknown event" warning and charged nothing. Billing (the dataset push) and the cap math in `store/budget.ts` are unchanged.
- `StoreAdapter.save()` may return a `SaveResult { saved, truncated, notSaved }` (internal; `SqliteStore` still returns nothing). `inserted` in the run stats now reports rows actually written.
- SQLite schema (self-hosted mode): four new columns, covered by the existing rebuild-on-old-schema migration.
- Dataset schema: the new fields are documented and added to the "full record" view.

#### Investigated, not changed
- **Null tickers on buy/sell rows are not parse misses.** In the 314-row sample, 112 `ok` rows have a null ticker: 47 municipal bonds, 33 `Other` (private LLCs/partnerships), 21 `Stock`, 8 `Non-Public Stock`, 3 `Corporate Bond`. Of the 21 `Stock` rows, 3 are Goldman structured notes and the rest are listed stocks/ADRs (Qualcomm, Nestle, Otis, …) whose ticker cell in the live PTR page is literally `--`. The source omits the ticker; filling it in would be guessing (Phase 2 enrichment).

### House actor (0.6.0)

House actor only (`0.5.0` → `0.6.0`), bringing it in line with the Senate actor's 1.5.0 changes. The Senate and Lobbying Overlap actors are unchanged. No pricing or charge-event changes. Every new input is optional and defaults to the previous behavior; the bug fixes under **Fixed** change output and are listed individually.

#### Added
- **Filters (all optional), same semantics as Senate.** `members` (case-insensitive; matches the normalized name *and* nicknames — `"Chuck Fleischmann"` matches `Charles J. "Chuck" Fleischmann`; a bioguide id or bare last name also works), `tickers`, `transactionDateFrom`, `transactionDateTo` (inclusive). `members` and `transactionDateFrom` are applied to the Clerk's **PTR index before any PDF is downloaded or parsed** (a filing filed before `transactionDateFrom` cannot contain a later trade); `tickers` and the exact trade-date bounds are applied to parsed rows. All filters run before anything is written or charged. When `tickers` or a trade-date filter is set, placeholder rows (content unknown) are not emitted; they are counted in `RUN_SUMMARY.placeholdersExcludedCount`.
- **`includeDuplicates`** input (default `false`) — see **Fixed**.
- **`politician_raw`** (the name exactly as the index printed it) and **`member_bioguide_id`** (resolved from the same congress-legislators roster and tiers as the Senate and Lobbying Overlap actors, House members; `null` when not a current member or ambiguous — never guessed) on every row.
- **`supersedes_filing_id`** / **`is_superseded`** on every row, set only where shared identical trades show it (the House source has no amends-link and no amendment number; `amendment_number` stays `null`).
- **`RUN_SUMMARY`** key-value record on every successful run: `{ truncated, reason, rowsEmitted, rowsNotEmitted, lastFilingDate, lastFilingId, windowFrom, windowTo, … }`. `truncated: true` means the run's maximum total charge stopped the dataset write short; the run also logs a warning and sets its status message.
- **`row_index_in_filing`** (0-based, source order, deterministic) on every row, so repeated line items inside one filing (the Donalds / Franklin pairs, which share a `content_hash`) can be told apart. `0` on a placeholder. Not part of `id` or `content_hash`; both are unchanged for every existing row (tested).
- `RUN_SUMMARY.placeholdersWithheld` and `RUN_SUMMARY.duplicatesCollapsed` (same names and meaning as Senate). The earlier `placeholdersExcludedCount` / `duplicatesRemoved` keys carry the same values and are kept.
- README "Charge cap behavior": a capped run stops *writing* but still downloads and parses every PDF in the window (cheap, deliberate for now).
- Tests: `filters`, `dedupCollapse`, `budget`, `normalizeFixes`, `inputReachesFetcher` (+ real-PDF fixtures `20035134`, `20035118`, `20035489`); 46 → 107.

#### Fixed
- **`fetchDaysBack`, `debugPtrLimit` and `enableOcr` were silently ignored on Apify** (same bug as Senate): written to `process.env` after `config.ts` had read the environment at import time. Run `IDgg2nQSlsPoPxJhr` asked for `fetchDaysBack: 30` and got a 90-day window (filings 2026-07-06 … 2026-09-25). Now passed explicitly. **Output change:** runs that set `fetchDaysBack` below 90 return fewer rows. The window has always been, and is now documented as, a **filing-date** window (`FilingDate` in the Clerk's index) — that run's `transaction_date` values spanning 2025-12 … 2026-09 are late-filed trades, not a window bug. Trade-date selection is the new `transactionDateFrom`/`transactionDateTo`.
- **A window crossing New Year now reads both calendar years' index ZIPs.** Previously only the current year's `<year>FD.zip` was read, so a window starting in December silently lost the December filings once January arrived.
- **Silent truncation at the max-charge cap** (475 = (1 − 0.05) / 0.002): the SDK trims what it writes and the run still ends `SUCCEEDED`. The actor now computes what the remaining budget covers, writes exactly that, bills only what it wrote, and reports the shortfall in `RUN_SUMMARY`. **Rows are now processed newest filing first** (the Clerk's index is alphabetical by member, so the previous cut silently lost everyone after "H" — Pelosi never appeared); a truncated run now loses the *oldest* filings, and `RUN_SUMMARY.lastFilingDate` says where it stopped. **Output change:** row order is newest-filing-first instead of alphabetical.
- **`"Scott Scott Franklin"`: the doubled token is in the source.** The 2026 index has `<First>Scott Scott</First><Last>Franklin</Last>` for both of his PTRs (DocIDs 20034050, 20035450), and the fetcher joined First + Last verbatim. (`"John John"` appears for another member.) Consecutive repeated name tokens are now collapsed (`Scott Franklin`); `politician_raw` keeps the original.
- **Owner code leaked into `asset_name`, and the row got `owner: "self"`.** The PDF prints the owner column (`SP`/`DC`/`JT`) with no separator before the asset name, and the old stripper only handled "Word"-case names (`SPApollo…`). All-caps and digit/dot/lowercase-leading names kept the code (`JTCADDO CNTY OKLA…`, `DCBWX Technologies`, `DCC.H. Robinson`, `SPe.l.f. Beauty`, `SPJP Morgan Chase`) and were mislabeled `self`. In run `IDgg2nQSlsPoPxJhr` that was 40 rows (Hern 10, April McClain Delaney 25, Gottheimer 3, Franklin 1, Guest 1). Now stripped when the evidence is unambiguous — a known ticker whose first letter matches the name without the code (never `SPX Technologies`/`SPDR`/`DCP`/`JTEKT`), or `JT` on a ticker-less row. Verified on the real PDFs: Hern's 14 rows are all `joint`, Delaney's 61 all `child`. **Output change:** `owner` and `asset_name` on those rows (and so their `content_hash`/`id`). Residual: a ticker-less, all-caps, spouse/child-owned row (`SPALPHAKEYS BLACKSTONE…`) is indistinguishable from a name that really starts with `SP`/`DC` and is left unchanged.
- **A wrapped `D:` description leaked into the NEXT row's `asset_name`.** The PDF wraps a comment line that fills the page width (observed at 101 and 115 characters; every unwrapped comment line in the fixtures is ≤ 54) onto the next line, and that continuation sits between the comment and the next row's asset name, where the name walk picked it up: Dingell's second HONAV row (PTR 20034960) read `Aerospace Inc. (HONAV) shares due to a spinoff. Honeywell Aerospace Inc. - Common Stock` and is now `Honeywell Aerospace Inc. - Common Stock`. The continuation now stays with its comment (a comment line of ≥ 95 characters continues onto the following line(s) until the first shorter one; the name's own last line is never consumed). Reproduced only for `D:`; the rule is generic over `F S`/`S O`/`D`/`L`/`C` comment lines, but no wrapped `F S:`, `S O:`, `L:` or `C:` line exists in any real PDF I have. **Output change:** `asset_name` — and so `content_hash` and `id` — on affected rows. Replaying the 44 filings behind the 475-row run (536 parsed rows, public Clerk PDFs re-parsed with the rule on and off): exactly **1** row changes (Dingell, PTR 20034960); no row counts, tickers, owners, amounts or dates change.
- **Dirty tickers**, same rules as Senate: `"-- AMCR"` → `AMCR`; a company-name abbreviation longer than 5 letters (`COLPAL`) → `null`; the fallback extractor no longer reads the hyphen in `ROLLS-ROYCE …` as a `"XXXX - Company"` delimiter (it now requires whitespace before the dash); several tickers in one cell → `null`. No ticker is ever looked up or guessed.
- **Exact cross-filing duplicates are removed by default**, same rules as Senate: rows from different filings by the same filer with an identical `content_hash` are returned once, from the filing with an `Amended` row (else the later `filing_date`); identical rows within one filing and rows that differ in `owner` are never touched. In run `IDgg2nQSlsPoPxJhr` this removes nothing — see below. `includeDuplicates: true` restores the old behavior.

#### Changed
- **README billing claim corrected (both READMEs).** Placeholder rows (`fetch_failed`, `scanned_unparsed`, `parse_failed`) are billed as a normal "Transaction record" event, like any row written to the default dataset; the "Billed? No" / "written for free" statements (1.4.0's "pay-per-event billing gate") were wrong and are removed. No pricing, event or output change — placeholders are still written to the default dataset.
- **Removed the dead `Actor.charge('transaction')` call** (unregistered event: it only logged a warning and charged nothing). Billing (the dataset push) and the cap math in `store/budget.ts` are unchanged.

#### Investigated, not changed
- **Placeholder rows are billed as "Transaction record" events and cannot be exempted from the actor.** The published pricing has one per-record event, `apify-default-dataset-item` ("Transaction record", $0.002 FREE tier), plus `apify-actor-start` ($0.05) — no custom `transaction` event. In apify@3.7.0 (`charging.js`) that synthetic event is "tracked locally only, the platform handles [it] automatically based on dataset writes", and every SDK client (including the `forceCloud` one) is the patched one, so every row written to the default dataset is billed whatever its `parse_status`. The 475-row cap (= (1 − 0.05) / 0.002) therefore included the 7 `scanned_unparsed` placeholders. The README's "Billed? No" for placeholders does not match this and was **not** changed; the existing `Actor.charge('transaction')` targets an unregistered event and charges nothing. Same finding and handling as the Senate actor. Tests pin the real cost model.
- **The "identical" pairs (Donalds, Franklin, …) are not duplicates.** 15 pairs in the 475-row run: 9 differ in `owner` (self vs spouse → different `content_hash`; one buy for each of two account owners), and the other 6 share owner and `content_hash` but sit in the *same* filing (repeated line items of one PTR). None spanned two filings.
- **Most null tickers on buy/sell rows are not parse misses.** 44 of 468 parsed rows: 33 `Government Security` (Treasuries and municipal bonds — Beyer, Clark, Cohen, DelBene, Hern, Bresnahan, Cisneros, Dingell), 6 `Other` (private funds; and `FAS` / `RSP ETF`, where the filer typed a ticker as the whole asset name — not extracted, since the rule is that a ticker is used only when the source gives one in the ticker slot or as `(XXXX)` / `XXXX - Name`), 3 `Corporate Bond`, 2 `Stock` (Ellington preferred; a private company). The one real parse bug in that list was the owner-code leak above (Hern's rows).
- **House Exchange rows have no given/received structure, so no `received_*` fields were added** (unlike Senate). The PDF prints ONE asset per exchange row — the asset acquired — with its own ticker in the `(TICKER) [ST]` marker and type code `E`; the other side of the exchange appears only in the free-text `D:` description (e.g. `Asset acquired when certain Honeywell International Inc. (HON) shares were exchanged for Honeywell Aerospace Inc. (HONAV) shares due to a spinoff.`). Real PTRs 20034960 (Dingell, HONAV) and 20035013 (Hern, XOM/HONAV) are now test fixtures.
- `scanned_unparsed` placeholders are unchanged (7 in that run: Cole, Fleischmann ×2, Harshbarger ×4).

## [1.4.0] - 2026-09-28

### Added
- **`asset_subtype`** field (`'ETF' | 'Mutual Fund' | null`) on every row, both actors. House derives it directly from the source PDF's own asset-type marker code (`[ET]`/`[MF]`) — a direct source signal. Senate has no such source signal (its own asset-type checkboxes have no ETF/fund option), so it falls back to matching `asset_name` text (`ETF`, `Fund`) only when the source's own `asset_type` is `"Stock"` — never overriding a more specific non-"Stock" label like `"Other"`.
- **Ticker fallback extraction**, both actors: when the structured `ticker` field is empty, extract it from `asset_name` text (`"Electronic Arts Inc. (EA)"`, `"EA - Electronic Arts Inc"`). A stoplist excludes entity suffixes and filing qualifiers (`LLC`, `Inc`, `Exchanged`, `Received`, etc.); deliberately no state-code blocklist, since several 2-letter postal codes are themselves live tickers (`MA` = Mastercard, `MS` = Morgan Stanley, `DE` = Deere). An exchange row's multiple parenthesized tickers resolve to the first (the asset being reported), not the received asset.
- **`amendment_number`** field on House rows for schema parity with Senate — always `null` (House's source exposes only a New/Amended flag, no sequence number).
- Senate: **paper-filing detection.** The listing's own link shape (`/search/view/paper/<id>/` vs `/search/view/ptr/<uuid>/`) now identifies a paper filing *before* fetching its detail page, and emits a `parse_status: "scanned_unparsed"` placeholder row instead of the filing silently vanishing (previously: the detail-page parser returned zero rows with only a log line, indistinguishable from a real error). A `/ptr/` link whose detail page still has zero table rows is tracked separately (`emptyPtrCount`) rather than assumed to be paper. Any listing link matching neither shape is counted and logged (`unknownDocTypeCount` + example URLs), surfaced in the run's `OUTPUT` key-value record.
- House: **`parse_status: "parse_failed"`** — distinct from `scanned_unparsed`. Fires when a filing's PDF *does* have a text layer and transaction markers were found, but no row matched the parser's expected shape (a parser gap, not a known source-format limitation). Previously such a filing returned zero rows with no trace. Counted as `parseFailedCount`, surfaced in the run's `OUTPUT` record and logged as a warning when nonzero.
- **Pay-per-event billing gate**, both actors: a placeholder row (`scanned_unparsed` or `parse_failed`) is still written to the dataset — it's real, useful output — but is never counted as a billable event on pay-per-event pricing. Only `parse_status: "ok"` rows are charged.

### Fixed
- **A single exact-dollar amount with cents was silently truncated to a whole dollar.** `stripAmount()` used `parseInt`, which stops at the first non-digit character (the decimal point) — `"$2,722.50"` became `2722`, not `2722.5`. Confirmed real-world case: House DocID 20034999, a Sale (Full) with no disclosure-bracket range, just an exact amount. Fixed to `parseFloat`; `amount_min`/`amount_max` are now `number` (not `int`) in both actors' schemas.
- House: the same DocID 20034999 case also used to be silently dropped entirely, one layer up — `TX_RE` required a bracketed `"$X - $Y"` range and matched nothing against a single exact amount, so the row never reached `stripAmount` in the first place. `TX_RE` now accepts either shape. Re-running the 90-day unfiltered measurement after the fix: `ok` filings rose from 113 to 114 (133 total, 19 `scanned_unparsed`, 0 `parse_failed`).

### Changed
- Senate: `transaction_date`, `asset_name`, `asset_type`, `type`, `amount_min`, and `owner` are now nullable, matching House's placeholder-row shape (null only on a `scanned_unparsed` placeholder row).
- Both actors bumped `0.4.x` → `0.5.0`.

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
