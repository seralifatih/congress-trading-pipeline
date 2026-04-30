import { format, subDays } from 'date-fns';
import { fetchAll } from '../fetcher/senateFetcher.js';
import { parseHtml } from '../parser/index.js';
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

  // ── Step 1: Fetch ────────────────────────────────────────────────────────────
  const fetchResult = await fetchAll(fromDate, toDate);

  if (!fetchResult.success && fetchResult.records.length === 0) {
    log.error(`Fetch failed with no records: ${fetchResult.error}`);
    return { inserted: 0, skipped: 0, errors: 1 };
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
  const normalized = normalizeAll(parsedRecords);
  const skipped = parsedRecords.length - normalized.length;
  log.info(`Normalized: ${normalized.length} valid, ${skipped} skipped`);

  if (normalized.length === 0) {
    log.warn('No valid records after normalization — nothing to store');
    return { inserted: 0, skipped, errors: 0 };
  }

  // ── Step 4: Load existing for dedup ─────────────────────────────────────────
  let existing: Transaction[] = [];
  try {
    existing = await store.query({ date_from: fromDate, limit: 10_000 });
  } catch (err) {
    log.warn(`Could not load existing records for dedup: ${toErrorMessage(err)}`);
  }

  // ── Step 5: Dedup ────────────────────────────────────────────────────────────
  const netNew = dedup(normalized, existing);
  log.info(`Dedup: ${netNew.length} net-new (${normalized.length - netNew.length} already stored)`);

  if (netNew.length === 0) {
    return { inserted: 0, skipped, errors: 0 };
  }

  // ── Step 6: Assign IDs and save ──────────────────────────────────────────────
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
