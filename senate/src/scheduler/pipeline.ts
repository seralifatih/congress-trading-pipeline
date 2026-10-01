import { fetchAll } from '../fetcher/senateFetcher.js';
import { parseHtml } from '../parser/index.js';
import { normalizeAll } from '../transformer/normalize.js';
import { SqliteStore } from '../store/sqliteStore.js';
import { dedup, generateId, computeContentHash, latestBySourceId, placeholdersByFilingId, collapseCrossFilingDuplicates } from '../utils/dedup.js';
import { buildMemberMatcher, loadSenateResolver, type NameResolver } from '../utils/legislators.js';
import { normalizeTickerFilterValue } from '../utils/input.js';
import { resolveWindow } from '../utils/window.js';
import { makeLogger } from '../utils/logger.js';
import { toErrorMessage } from '../utils/errors.js';
import { config } from '../utils/config.js';
import type { Transaction, StoreAdapter } from '../types/index.js';

const log = makeLogger('pipeline');

const PLACEHOLDER_STATUSES = new Set(['fetch_failed', 'scanned_unparsed', 'parse_failed']);

export interface PipelineStats {
  inserted: number;
  skipped: number;
  errors: number;
  // Filing-format counters for this run — see FetchResult in types/index.ts.
  // Surfaced to Actor.setValue('OUTPUT', ...) so a production run's
  // electronic-vs-paper ratio can be read back without re-scraping the
  // listing separately.
  electronicPtrCount: number;
  paperCount: number;
  emptyPtrCount: number;
  unknownDocTypeCount: number;
  unknownDocTypeExamples: string[];
  // Count of filings that produced a 'fetch_failed' placeholder this run —
  // see FetchResult in types/index.ts. Surfaced so a transient
  // network/host failure shows up in run stats instead of the filing
  // silently vanishing.
  fetchFailedCount: number;
  // ── Filters, dedup and the charge cap ─────────────────────────────────────
  // The filing-date window actually used (inclusive, YYYY-MM-DD).
  windowFrom: string;
  windowTo: string;
  // Filings skipped before their detail page was fetched (members /
  // transactionDateFrom inputs).
  skippedByMemberCount: number;
  skippedByTransactionDateCount: number;
  // Rows removed after parsing, before anything is written or charged.
  filteredByTickerCount: number;
  filteredByTransactionDateCount: number;
  // Placeholder rows (content unknown) withheld because a tickers /
  // transaction-date filter is active and can't be evaluated on them.
  placeholdersExcludedCount: number;
  // Exact cross-filing duplicates removed (same content_hash, different filing).
  duplicatesRemoved: number;
  supersessionsFound: number;
  // True when the run's max total charge stopped the dataset write short.
  truncated: boolean;
  truncationReason?: 'max_total_charge_reached';
  // Rows actually written to the dataset (== inserted) and rows left out.
  rowsEmitted: number;
  rowsNotEmitted: number;
  // filing_date / filing_id of the last row written. Rows are written
  // newest-filing-first, so on truncation this is the oldest filing reached.
  lastFilingDate: string | null;
  lastFilingId: string | null;
}

export interface PipelineOptions {
  fromDate?: string;
  toDate?: string;
  // Rolling window length, used only when fromDate is not set. Falls back to
  // the FETCH_DAYS_BACK env var (default 90).
  fetchDaysBack?: number;
  debugPtrLimit?: number;
  // Case-insensitive; matched against normalized names AND nicknames.
  members?: string[];
  tickers?: string[];
  transactionDateFrom?: string;
  transactionDateTo?: string;
  // Keep exact cross-filing duplicates instead of removing them.
  includeDuplicates?: boolean;
  // Test seam: undefined -> load the Senate roster from congress-legislators;
  // null -> no roster (bioguide ids stay null).
  resolver?: NameResolver | null;
}

function emptyStats(window: { fromDate: string; toDate: string }): PipelineStats {
  return {
    inserted: 0, skipped: 0, errors: 0,
    electronicPtrCount: 0, paperCount: 0, emptyPtrCount: 0,
    unknownDocTypeCount: 0, unknownDocTypeExamples: [], fetchFailedCount: 0,
    windowFrom: window.fromDate, windowTo: window.toDate,
    skippedByMemberCount: 0, skippedByTransactionDateCount: 0,
    filteredByTickerCount: 0, filteredByTransactionDateCount: 0,
    placeholdersExcludedCount: 0,
    duplicatesRemoved: 0, supersessionsFound: 0,
    truncated: false, rowsEmitted: 0, rowsNotEmitted: 0,
    lastFilingDate: null, lastFilingId: null,
  };
}

// ─── Row filters (tickers / transaction date) ─────────────────────────────────
// Applied to normalized rows, always before anything is saved or charged.
// Exported for unit tests.

export interface RowFilterOptions {
  tickers: string[];
  transactionDateFrom?: string;
  transactionDateTo?: string;
}

export interface RowFilterResult {
  kept: Transaction[];
  filteredByTicker: number;
  filteredByTransactionDate: number;
  placeholdersExcluded: number;
}

export function filterRows(rows: Transaction[], options: RowFilterOptions): RowFilterResult {
  const tickerSet = new Set(options.tickers.map(normalizeTickerFilterValue));
  const active = tickerSet.size > 0 || !!options.transactionDateFrom || !!options.transactionDateTo;
  if (!active) return { kept: rows, filteredByTicker: 0, filteredByTransactionDate: 0, placeholdersExcluded: 0 };

  const kept: Transaction[] = [];
  let filteredByTicker = 0;
  let filteredByTransactionDate = 0;
  let placeholdersExcluded = 0;

  for (const t of rows) {
    // A placeholder carries no ticker or transaction date, so these filters
    // can't be evaluated on it. Excluded rather than guessed at.
    if (t.parse_status !== 'ok') {
      placeholdersExcluded++;
      continue;
    }
    const d = t.transaction_date;
    if (
      (options.transactionDateFrom && (d === null || d < options.transactionDateFrom)) ||
      (options.transactionDateTo && (d === null || d > options.transactionDateTo))
    ) {
      filteredByTransactionDate++;
      continue;
    }
    if (tickerSet.size > 0 && !(t.ticker !== null && tickerSet.has(normalizeTickerFilterValue(t.ticker)))) {
      filteredByTicker++;
      continue;
    }
    kept.push(t);
  }
  return { kept, filteredByTicker, filteredByTransactionDate, placeholdersExcluded };
}

export async function runPipeline(
  store: StoreAdapter = SqliteStore.getInstance(),
  options: PipelineOptions = {},
): Promise<PipelineStats> {
  log.info('Pipeline start');

  const window = resolveWindow(options, config.FETCH_DAYS_BACK);
  const { fromDate, toDate } = window;
  const stats = emptyStats(window);
  const members = options.members ?? [];
  const tickers = options.tickers ?? [];
  log.info(`Window (filing date): ${fromDate} .. ${toDate}`);

  if (options.transactionDateFrom && options.transactionDateFrom < fromDate) {
    log.warn(
      `transactionDateFrom=${options.transactionDateFrom} is earlier than the filing-date window start ` +
      `${fromDate}. The window selects filings by FILING date, so a trade from before ${fromDate} is only ` +
      `returned if it was reported in a filing submitted on/after ${fromDate}. Widen fetchDaysBack/fromDate ` +
      `to catch trades that were filed earlier.`,
    );
  }

  const resolver = options.resolver === undefined ? await loadSenateResolver() : options.resolver;
  const memberMatcher = members.length > 0 ? buildMemberMatcher(members, resolver) : undefined;

  // ── Step 1: Fetch ────────────────────────────────────────────────────────────
  const fetchResult = await fetchAll(fromDate, toDate, {
    debugPtrLimit: options.debugPtrLimit,
    memberMatcher,
    transactionDateFrom: options.transactionDateFrom,
  });
  const { electronicPtrCount, paperCount, emptyPtrCount, unknownDocTypeCount, unknownDocTypeExamples, fetchFailedCount } = fetchResult;
  Object.assign(stats, {
    electronicPtrCount, paperCount, emptyPtrCount, unknownDocTypeCount, unknownDocTypeExamples, fetchFailedCount,
    skippedByMemberCount: fetchResult.skippedByMemberCount ?? 0,
    skippedByTransactionDateCount: fetchResult.skippedByTransactionDateCount ?? 0,
  });
  log.info(
    `Filing formats: electronic=${electronicPtrCount}, paper=${paperCount}, ` +
    `empty=${emptyPtrCount}, fetchFailed=${fetchFailedCount}, unknownDocType=${unknownDocTypeCount}`,
  );
  if (fetchFailedCount > 0) {
    log.warn(`${fetchFailedCount} filing(s) produced a fetch_failed placeholder this run`);
  }

  if (!fetchResult.success && fetchResult.records.length === 0) {
    log.error(`Fetch failed with no records: ${fetchResult.error}`);
    return { ...stats, errors: 1 };
  }

  if (!fetchResult.success) {
    log.warn(`Partial fetch (${fetchResult.records.length} records): ${fetchResult.error}`);
  }

  const rawRecords = fetchResult.records;
  log.info(`Fetched ${rawRecords.length} raw records`);

  // ── Step 2: Parse — HTML fallback when structured listing returned empties ──
  let parsedRecords = rawRecords;

  const structuredEmpty = rawRecords.length > 0 && rawRecords.every((r) => !r.asset_name.trim());
  if (structuredEmpty) {
    log.warn('Structured parse produced no asset names — attempting HTML fallback');
    try {
      const htmlHits = rawRecords
        .map((r) => r.raw_json)
        .filter((j): j is Record<string, unknown> => !!j['html'])
        .map((j) => j['html'] as string);

      if (htmlHits.length > 0) {
        parsedRecords = parseHtml(htmlHits.join('\n'));
        log.info(`HTML fallback produced ${parsedRecords.length} records`);
      } else {
        log.warn('No html field in raw_json — cannot fall back to HTML parser');
      }
    } catch (err) {
      log.error(`HTML fallback failed: ${toErrorMessage(err)}`);
    }
  }

  // ── Step 3: Normalize ────────────────────────────────────────────────────────
  const normalizedAll = normalizeAll(parsedRecords);
  const skipped = parsedRecords.length - normalizedAll.length;
  stats.skipped = skipped;
  log.info(`Normalized: ${normalizedAll.length} valid, ${skipped} skipped`);

  // Bioguide ids, from the roster — null when the name doesn't resolve to
  // exactly one current senator (or the roster couldn't be loaded).
  const bioguideByName = new Map<string, string | null>();
  for (const t of normalizedAll) {
    const key = t.politician_raw ?? t.politician;
    if (!bioguideByName.has(key)) bioguideByName.set(key, resolver?.resolve(key) ?? null);
    t.member_bioguide_id = bioguideByName.get(key) ?? null;
  }

  // ── Step 3b: Row filters — before dedup, before anything is saved/charged ───
  const rowFilter = filterRows(normalizedAll, {
    tickers,
    transactionDateFrom: options.transactionDateFrom,
    transactionDateTo: options.transactionDateTo,
  });
  stats.filteredByTickerCount = rowFilter.filteredByTicker;
  stats.filteredByTransactionDateCount = rowFilter.filteredByTransactionDate;
  stats.placeholdersExcludedCount = rowFilter.placeholdersExcluded;
  if (rowFilter.kept.length !== normalizedAll.length) {
    log.info(
      `Row filters: ${rowFilter.kept.length}/${normalizedAll.length} rows kept ` +
      `(${rowFilter.filteredByTicker} by tickers, ${rowFilter.filteredByTransactionDate} by transaction date, ` +
      `${rowFilter.placeholdersExcluded} placeholder(s) withheld)`,
    );
  }

  // ── Step 3c: Cross-filing duplicates / supersession ─────────────────────────
  const collapsed = collapseCrossFilingDuplicates(rowFilter.kept, {
    dropDuplicates: options.includeDuplicates !== true,
  });
  stats.duplicatesRemoved = collapsed.duplicatesRemoved;
  stats.supersessionsFound = collapsed.supersessionsFound;
  if (collapsed.duplicatesRemoved > 0) {
    log.info(`Removed ${collapsed.duplicatesRemoved} exact cross-filing duplicate row(s) (amendment copy kept)`);
  }
  const normalized = collapsed.rows;

  if (normalized.length === 0) {
    log.warn('No valid records after normalization/filters — nothing to store');
    return stats;
  }

  // ── Step 4: Load existing for dedup ─────────────────────────────────────────
  let existing: Transaction[] = [];
  try {
    existing = await store.query({ date_from: fromDate, limit: 10_000 });
  } catch (err) {
    log.warn(`Could not load existing records for dedup: ${toErrorMessage(err)}`);
  }

  // ── Step 4b: Placeholder supersession ───────────────────────────────────────
  // Two symmetric cases, both keyed by filing_id (not source_id — see
  // utils/dedup.ts placeholdersByFilingId for why):
  //
  //   1. Incoming has a real ("ok") row for a filing_id that already has a
  //      stale placeholder (fetch_failed/scanned_unparsed/parse_failed) in
  //      storage — that placeholder is now wrong and must go. Collected into
  //      staleFilingIds and deleted via store.deleteByFilingIds below.
  //
  //   2. Incoming is ITSELF a placeholder for a filing_id that already has
  //      real ("ok") rows in storage — a transient re-fetch failure on a
  //      filing we already successfully parsed before. Writing this
  //      placeholder would be a regression (real data replaced by "we
  //      don't know"), so it's filtered out of the batch entirely rather
  //      than saved.
  const existingPlaceholderByFilingId = placeholdersByFilingId(existing);
  const existingRealFilingIds = new Set(
    existing.filter((t) => t.parse_status === 'ok').map((t) => t.filing_id),
  );

  const staleFilingIds = new Set<string>();
  const filtered: Transaction[] = [];
  for (const t of normalized) {
    const isReal = t.parse_status === 'ok';
    const isPlaceholder = PLACEHOLDER_STATUSES.has(t.parse_status);

    if (isReal && existingPlaceholderByFilingId.has(t.filing_id)) {
      staleFilingIds.add(t.filing_id);
    }
    if (isPlaceholder && existingRealFilingIds.has(t.filing_id)) {
      log.info(
        `Discarding ${t.parse_status} placeholder for filing_id="${t.filing_id}" — ` +
        `real transaction rows already exist for this filing; a transient re-fetch ` +
        `failure must never downgrade already-confirmed data`,
      );
      continue;
    }
    filtered.push(t);
  }

  // ── Step 5: Dedup ────────────────────────────────────────────────────────────
  const netNew = dedup(filtered, existing);
  log.info(`Dedup: ${netNew.length} net-new (${filtered.length - netNew.length} already stored)`);

  if (netNew.length === 0) {
    return stats;
  }

  // ── Step 6: Assign IDs, fetch/revision metadata, and save ───────────────────
  // content_hash is additive — computed here, alongside id, but does not
  // affect id's formula or inputs.
  //
  // fetchedAt/lastModifiedAt/revisionCount are keyed off source_id (not the
  // dedup key or id, both of which change when content changes). A prior row
  // sharing source_id but a different content_hash means the source revised
  // this exact filing row — carry fetchedAt forward from that prior row so
  // "first seen" survives the revision, bump lastModifiedAt to now, and
  // increment revisionCount. No prior source_id match means a genuinely new
  // row: fetchedAt = lastModifiedAt = now, revisionCount = 0.
  const priorBySourceId = latestBySourceId(existing);
  const now = new Date().toISOString();

  const withIds: Transaction[] = netNew.map((t) => {
    const content_hash = computeContentHash(t);
    const prior = priorBySourceId.get(t.source_id);

    if (prior && prior.content_hash !== content_hash) {
      log.warn(
        `Revision detected: source_id="${t.source_id}" politician="${t.politician}" ` +
        `content_hash ${prior.content_hash} -> ${content_hash} ` +
        `(revision #${(prior.revisionCount ?? 0) + 1})`,
      );
      return {
        ...t,
        id: generateId(t),
        content_hash,
        fetchedAt: prior.fetchedAt ?? now,
        lastModifiedAt: now,
        revisionCount: (prior.revisionCount ?? 0) + 1,
      };
    }

    return {
      ...t,
      id: generateId(t),
      content_hash,
      fetchedAt: now,
      lastModifiedAt: now,
      revisionCount: 0,
    };
  });

  // Regression guard: ids must be unique within this batch. A collision here
  // means two records hashed identically despite source_id being part of the
  // key — never silently drop or dedupe past this; fail loudly instead, since
  // billing is per-record and a silent drop would be a billing-correctness bug.
  const idCounts = new Map<string, number>();
  for (const t of withIds) idCounts.set(t.id!, (idCounts.get(t.id!) ?? 0) + 1);
  const idDupes = [...idCounts.entries()].filter(([, n]) => n > 1);
  if (idDupes.length > 0) {
    const detail = idDupes.map(([id, n]) => `${id} (x${n})`).join(', ');
    throw new Error(`Duplicate transaction ids in batch — refusing to save: ${detail}`);
  }

  let errors = 0;
  let emitted = 0;
  try {
    const saveResult = await store.save(withIds);
    emitted = saveResult?.saved ?? withIds.length;
    if (saveResult?.truncated) {
      stats.truncated = true;
      stats.truncationReason = saveResult.reason ?? 'max_total_charge_reached';
      stats.rowsNotEmitted = saveResult.notSaved;
    }
    log.info(`Saved ${emitted} transactions`);
  } catch (err) {
    log.error(`Store save failed: ${toErrorMessage(err)}`);
    errors = 1;
  }

  // Delete stale placeholders AFTER the real rows are confirmed saved — if
  // save() above throws, we keep the old placeholder rather than deleting
  // it and ending up with neither (a real silent-drop, which is exactly
  // what this whole mechanism exists to prevent).
  if (staleFilingIds.size > 0 && errors === 0) {
    try {
      await store.deleteByFilingIds([...staleFilingIds]);
    } catch (err) {
      log.warn(`Could not delete stale placeholder(s): ${toErrorMessage(err)}`);
    }
  }

  const last = emitted > 0 ? withIds[emitted - 1]! : null;
  return {
    ...stats,
    inserted: emitted,
    errors,
    rowsEmitted: emitted,
    lastFilingDate: last?.filing_date ?? null,
    lastFilingId: last?.filing_id ?? null,
  };
}
