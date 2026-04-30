import { format, subDays } from 'date-fns';
import { fetchAll } from '../fetcher/senateFetcher.js';
import { fetchAllHouse } from '../fetcher/houseFetcher.js';
import { parseHtml } from '../parser/index.js';
import { normalizeAll } from '../transformer/normalize.js';
import { SqliteStore } from '../store/sqliteStore.js';
import { dedup, generateId } from '../utils/dedup.js';
import { makeLogger } from '../utils/logger.js';
import { toErrorMessage } from '../utils/errors.js';
import { config } from '../utils/config.js';
import type { Transaction, StoreAdapter, RawTransaction, FetchResult } from '../types/index.js';

const log = makeLogger('pipeline');

export interface PipelineStats {
  inserted: number;
  skipped: number;
  errors: number;
}

export interface PipelineOptions {
  fromDate?: string;
  toDate?: string;
  includeSenate?: boolean;
  includeHouse?: boolean;
}

export async function runPipeline(
  store: StoreAdapter = SqliteStore.getInstance(),
  options: PipelineOptions = {},
): Promise<PipelineStats> {
  log.info('Pipeline start');

  const fromDate = options.fromDate ?? format(subDays(new Date(), config.FETCH_DAYS_BACK), 'yyyy-MM-dd');
  const toDate   = options.toDate   ?? format(new Date(), 'yyyy-MM-dd');

  const includeSenate = options.includeSenate !== false;
  const includeHouse  = options.includeHouse  !== false;

  // ── Step 1: Fetch from Senate + House in parallel ───────────────────────────
  const emptyResult: FetchResult = { success: true, records: [] };
  const [senateResult, houseResult] = await Promise.all<FetchResult>([
    includeSenate ? fetchAll(fromDate, toDate) : Promise.resolve(emptyResult),
    includeHouse  ? fetchAllHouse(fromDate, toDate) : Promise.resolve(emptyResult),
  ]);

  if (includeSenate) {
    log.info(`Senate: ${senateResult.records.length} records${senateResult.success ? '' : ` (partial: ${senateResult.error})`}`);
  }
  if (includeHouse) {
    log.info(`House: ${houseResult.records.length} records${houseResult.success ? '' : ` (partial: ${houseResult.error})`}`);
  }

  const rawRecords: RawTransaction[] = [...senateResult.records, ...houseResult.records];

  if (rawRecords.length === 0) {
    const senateErr = senateResult.success ? '' : ` Senate: ${senateResult.error}.`;
    const houseErr  = houseResult.success  ? '' : ` House: ${houseResult.error}.`;
    log.error(`Fetch failed with no records.${senateErr}${houseErr}`);
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  log.info(`Fetched ${rawRecords.length} raw records total (Senate=${senateResult.records.length}, House=${houseResult.records.length})`);

  // ── Step 2: Parse ────────────────────────────────────────────────────────────
  // Both fetchers already produce RawTransaction shape. Senate HTML fallback
  // applies only to Senate listings.
  let parsedRecords = rawRecords;

  const senateOnly = senateResult.records;
  const senateEmpty = senateOnly.length > 0 && senateOnly.every((r) => !r.asset_name.trim());
  if (senateEmpty) {
    log.warn('Senate structured parse produced no asset names — attempting HTML fallback');
    try {
      const htmlHits = senateOnly
        .map((r) => r.raw_json)
        .filter((j): j is Record<string, unknown> => !!j['html'])
        .map((j) => j['html'] as string);

      if (htmlHits.length > 0) {
        const fallback = parseHtml(htmlHits.join('\n'));
        parsedRecords = [...fallback, ...houseResult.records];
        log.info(`HTML fallback produced ${fallback.length} Senate records`);
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

  // ── Step 4: Load existing (rolling window) for dedup ─────────────────────────
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
