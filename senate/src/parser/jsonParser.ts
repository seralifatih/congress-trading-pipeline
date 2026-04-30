import type { RawTransaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('jsonParser');

// ─── Loose shape — every field optional, all unknown ─────────────────────────
// We accept whatever _source gives us and fall back to '' rather than throwing.

type EfdSource = Record<string, unknown>;

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return String(v);
}

function resolveName(src: EfdSource): string {
  if (src['senator_name']) return str(src['senator_name']).trim();
  const first = str(src['first_name']).trim();
  const last = str(src['last_name']).trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  return '';
}

function resolveFilingDate(src: EfdSource): string {
  return str(src['date_filed'] ?? src['filing_date']);
}

// ─── Parse a single _source object ───────────────────────────────────────────

export function parseJsonSource(source: EfdSource, id: string = ''): RawTransaction {
  return {
    politician: resolveName(source),
    transaction_date: str(source['transaction_date']),
    filing_date: resolveFilingDate(source),
    ticker: str(source['ticker']),
    asset_name: str(source['asset_name']),
    asset_type: str(source['asset_type']),
    type: str(source['transaction_type']),
    amount: str(source['amount']),
    owner: str(source['owner']),
    source_id: id || str(source['report_id']),
    raw_json: source,
  };
}

// ─── Parse an array of hits (each with _id + _source) ────────────────────────

interface EfdHit {
  _id?: unknown;
  _source?: unknown;
}

export function parseJsonHits(hits: unknown[]): RawTransaction[] {
  const results: RawTransaction[] = [];

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i] as EfdHit;

    if (!hit || typeof hit !== 'object') {
      log.warn(`Hit ${i} is not an object — skipping`);
      continue;
    }

    if (!hit._source || typeof hit._source !== 'object') {
      log.warn(`Hit ${i} missing _source — skipping`);
      continue;
    }

    results.push(parseJsonSource(hit._source as EfdSource, str(hit._id)));
  }

  return results;
}
