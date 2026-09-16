import { format, subDays } from 'date-fns';
import { fetchAll } from '../fetcher/senateFetcher.js';
import { parseHtml } from '../parser/index.js';
import { normalizeAll } from '../transformer/normalize.js';
import { SqliteStore } from '../store/sqliteStore.js';
import { dedup, generateId, computeContentHash, latestBySourceId } from '../utils/dedup.js';
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
  try {
    await store.save(withIds);
    log.info(`Saved ${withIds.length} transactions`);
  } catch (err) {
    log.error(`Store save failed: ${toErrorMessage(err)}`);
    errors = 1;
  }

  return { inserted: withIds.length, skipped, errors };
}
