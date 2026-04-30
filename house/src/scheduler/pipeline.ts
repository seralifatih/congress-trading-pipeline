import { format, subDays } from 'date-fns';
import { fetchAllHouse } from '../fetcher/houseFetcher.js';
import { normalizeAll } from '../transformer/normalize.js';
import { SqliteStore } from '../store/sqliteStore.js';
import { dedup, generateId } from '../utils/dedup.js';
import { makeLogger } from '../utils/logger.js';
import { toErrorMessage } from '../utils/errors.js';
import { config } from '../utils/config.js';
import type { Transaction, StoreAdapter } from '../types/index.js';

const log = makeLogger('pipeline');

export interface PipelineStats {
  inserted: number;
  skipped: number;
  errors: number;
}

export interface PipelineOptions {
  fromDate?: string;
  toDate?: string;
}

export async function runPipeline(
  store: StoreAdapter = SqliteStore.getInstance(),
  options: PipelineOptions = {},
): Promise<PipelineStats> {
  log.info('Pipeline start');

  const fromDate = options.fromDate ?? format(subDays(new Date(), config.FETCH_DAYS_BACK), 'yyyy-MM-dd');
  const toDate   = options.toDate   ?? format(new Date(), 'yyyy-MM-dd');

  // ── Step 1: Fetch House ZIP + per-PTR PDFs ──────────────────────────────────
  const fetchResult = await fetchAllHouse(fromDate, toDate);

  if (!fetchResult.success && fetchResult.records.length === 0) {
    log.error(`Fetch failed with no records: ${fetchResult.error}`);
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  if (!fetchResult.success) {
    log.warn(`Partial fetch (${fetchResult.records.length} records): ${fetchResult.error}`);
  }

  const rawRecords = fetchResult.records;
  log.info(`Fetched ${rawRecords.length} raw records`);

  // ── Step 2: Normalize ───────────────────────────────────────────────────────
  const normalized = normalizeAll(rawRecords);
  const skipped = rawRecords.length - normalized.length;
  log.info(`Normalized: ${normalized.length} valid, ${skipped} skipped`);

  if (normalized.length === 0) {
    log.warn('No valid records after normalization — nothing to store');
    return { inserted: 0, skipped, errors: 0 };
  }

  // ── Step 3: Load existing for dedup ─────────────────────────────────────────
  let existing: Transaction[] = [];
  try {
    existing = await store.query({ date_from: fromDate, limit: 10_000 });
  } catch (err) {
    log.warn(`Could not load existing records for dedup: ${toErrorMessage(err)}`);
  }

  // ── Step 4: Dedup ───────────────────────────────────────────────────────────
  const netNew = dedup(normalized, existing);
  log.info(`Dedup: ${netNew.length} net-new (${normalized.length - netNew.length} already stored)`);

  if (netNew.length === 0) {
    return { inserted: 0, skipped, errors: 0 };
  }

  // ── Step 5: Assign IDs and save ─────────────────────────────────────────────
  const withIds: Transaction[] = netNew.map((t) => ({ ...t, id: generateId(t) }));

  let errors = 0;
  try {
    await store.save(withIds);
    log.info(`Saved ${withIds.length} transactions`);
  } catch (err) {
    log.error(`Store save failed: ${toErrorMessage(err)}`);
    errors = 1;
  }

  return { inserted: withIds.length, skipped, errors };
}
