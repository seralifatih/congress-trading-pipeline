import { parse as parseDate, isValid, format } from 'date-fns';
import type { RawTransaction, Transaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('normalize');

// ─── Type mapping ─────────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, 'buy' | 'sell'> = {
  'purchase':      'buy',
  'sale (full)':   'sell',
  'sale (partial)':'sell',
  'sale_full':     'sell',
  'sale_partial':  'sell',
  'sale':          'sell',
};

function normalizeType(raw: string): 'buy' | 'sell' | null {
  const key = raw.trim().toLowerCase();
  return TYPE_MAP[key] ?? null;
}

// ─── Amount parsing ───────────────────────────────────────────────────────────
// Handles:
//   "$1,001 - $15,000"   →  { min: 1001, max: 15000 }
//   "$500,000 - Over"    →  { min: 500000, max: null }
//   "Over $50,000,000"   →  { min: 50000000, max: null }
//   "$15,001"            →  { min: 15001, max: 15001 } (single value)
//   ""                   →  { min: 0, max: null }

function stripAmount(s: string): number {
  const cleaned = s.replace(/[$,\s]/g, '');
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

interface AmountRange {
  amount_min: number;
  amount_max: number | null;
}

function parseAmount(raw: string): AmountRange {
  const trimmed = raw.trim();

  if (!trimmed) return { amount_min: 0, amount_max: null };

  const lc = trimmed.toLowerCase();

  // "Over $X,XXX,XXX" — unbounded lower bound becomes min, max is null
  const overMatch = lc.match(/^over\s+(.+)$/);
  if (overMatch) {
    return { amount_min: stripAmount(overMatch[1]!), amount_max: null };
  }

  // "$X - Over" or "$X - Over $Y" — treat right side as unbounded
  const rangeOverMatch = trimmed.match(/^(.+?)\s*[-–]\s*[Oo]ver/);
  if (rangeOverMatch) {
    return { amount_min: stripAmount(rangeOverMatch[1]!), amount_max: null };
  }

  // "$X - $Y" or "$X – $Y"
  const rangeMatch = trimmed.match(/^(.+?)\s*[-–]\s*(.+)$/);
  if (rangeMatch) {
    return {
      amount_min: stripAmount(rangeMatch[1]!),
      amount_max: stripAmount(rangeMatch[2]!),
    };
  }

  // Single value
  const single = stripAmount(trimmed);
  return { amount_min: single, amount_max: single };
}

// ─── Date parsing ─────────────────────────────────────────────────────────────
// Accepts: "YYYY-MM-DD", "M/D/YYYY", "MM/DD/YYYY"
// Returns: "YYYY-MM-DD" or null if unparseable

const DATE_FORMATS = ['yyyy-MM-dd', 'M/d/yyyy', 'MM/dd/yyyy', 'M/d/yy'];

function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  for (const fmt of DATE_FORMATS) {
    const parsed = parseDate(trimmed, fmt, new Date());
    if (isValid(parsed)) return format(parsed, 'yyyy-MM-dd');
  }

  log.warn(`Unparseable date: "${trimmed}"`);
  return null;
}

// ─── Owner mapping ────────────────────────────────────────────────────────────

const OWNER_MAP: Record<string, Transaction['owner']> = {
  'self':          'self',
  'joint':         'joint',
  'joint (self)':  'joint',
  'spouse':        'spouse',
  'sp':            'spouse',
  'child':         'child',
  'dependent':     'child',
  'dc':            'child',
};

function normalizeOwner(raw: string): Transaction['owner'] {
  const key = raw.trim().toLowerCase();
  return OWNER_MAP[key] ?? 'self';
}

// ─── Ticker normalization ─────────────────────────────────────────────────────

function normalizeTicker(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  if (!t || t === '--' || t === 'N/A' || t === 'NA') return null;
  return t;
}

// ─── Validation ───────────────────────────────────────────────────────────────

type SkipReason =
  | 'missing_politician'
  | 'missing_both_dates'
  | 'missing_asset_name'
  | 'unrecognized_type';

function skipReason(raw: RawTransaction, type: 'buy' | 'sell' | null): SkipReason | null {
  if (!raw.politician.trim()) return 'missing_politician';
  if (!raw.transaction_date.trim() && !raw.filing_date.trim()) return 'missing_both_dates';
  if (!raw.asset_name.trim()) return 'missing_asset_name';
  if (type === null) return 'unrecognized_type';
  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function normalize(raw: RawTransaction): Transaction | null {
  const type = normalizeType(raw.type);
  const reason = skipReason(raw, type);

  if (reason !== null) return null;

  const transaction_date = normalizeDate(raw.transaction_date);
  const filing_date = normalizeDate(raw.filing_date);

  // If both dates are present but both fail to parse, still reject
  if (transaction_date === null && filing_date === null) return null;

  const { amount_min, amount_max } = parseAmount(raw.amount);

  return {
    politician: raw.politician.trim(),
    transaction_date: transaction_date ?? filing_date!,
    filing_date: filing_date ?? transaction_date!,
    ticker: normalizeTicker(raw.ticker),
    asset_name: raw.asset_name.trim(),
    asset_type: raw.asset_type.trim(),
    type: type!,
    amount_min,
    amount_max,
    owner: normalizeOwner(raw.owner),
  };
}

export function normalizeAll(raws: RawTransaction[]): Transaction[] {
  const results: Transaction[] = [];
  let skipped = 0;

  for (const raw of raws) {
    const type = normalizeType(raw.type);
    const reason = skipReason(raw, type);

    if (reason !== null) {
      log.warn(
        `Skipping record source_id="${raw.source_id}" politician="${raw.politician}" reason=${reason}`,
      );
      skipped++;
      continue;
    }

    const result = normalize(raw);
    if (result === null) {
      // normalize() returned null for a date-parse failure not caught by skipReason
      log.warn(
        `Skipping record source_id="${raw.source_id}" reason=unparseable_dates`,
      );
      skipped++;
      continue;
    }

    results.push(result);
  }

  if (skipped > 0) {
    log.info(`normalizeAll: ${results.length} kept, ${skipped} skipped`);
  }

  return results;
}
