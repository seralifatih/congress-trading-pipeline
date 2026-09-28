import { parse as parseDate, isValid, format } from 'date-fns';
import type { RawTransaction, Transaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('normalize');

// ─── Type mapping ─────────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, 'buy' | 'sell' | 'exchange'> = {
  'purchase':      'buy',
  'sale (full)':   'sell',
  'sale (partial)':'sell',
  'sale_full':     'sell',
  'sale_partial':  'sell',
  'sale':          'sell',
  'exchange':      'exchange',
};

function normalizeType(raw: string): 'buy' | 'sell' | 'exchange' | null {
  const key = raw.trim().toLowerCase();
  return TYPE_MAP[key] ?? null;
}

// ─── Amount parsing ───────────────────────────────────────────────────────────
// Handles:
//   "$1,001 - $15,000"   →  { min: 1001, max: 15000 }
//   "$500,000 - Over"    →  { min: 500000, max: null }
//   "Over $50,000,000"   →  { min: 50000000, max: null }
//   "$15,001"            →  { min: 15001, max: 15001 } (single value)
//   "$2,722.50"          →  { min: 2722.5, max: 2722.5 } (single exact amount with cents)
//   ""                   →  { min: 0, max: null }

function stripAmount(s: string): number {
  const cleaned = s.replace(/[$,\s]/g, '');
  // parseFloat, not parseInt — a single exact-amount disclosure (as opposed
  // to a bracketed range) can report cents, e.g. "$2,722.50" — see the
  // House actor's DocID 20034999 for a confirmed real-world case.
  // parseInt would silently truncate that to 2722.
  const n = parseFloat(cleaned);
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

// ─── Ticker fallback extraction (from asset_name) ─────────────────────────────
// The Senate/House filings frequently embed the ticker in the free-text asset
// name instead of (or in addition to) the dedicated ticker field, e.g.
//   "Electronic Arts Inc. (EA)"
//   "EA - Electronic Arts Inc"
//   "AvalonBay Communities, Inc. Common Stock (AVB) (Exchanged) VMRK - Vivmark ..."
// When the structured field comes back empty, fall back to pulling it out of
// asset_name. 1-5 uppercase letters, optional ".X" share-class suffix.

// Parenthesized words that are never tickers even though they match the
// shape: entity suffixes and filing qualifiers, not real securities. State
// postal codes are deliberately NOT on this list — several are also live
// tickers (MA = Mastercard, MS = Morgan Stanley, DE = Deere, MO = Altria,
// OR, HI, AR, IT...). Real "(City, ST)" addresses are excluded structurally
// below (the paren content isn't purely uppercase letters), so a state-code
// stoplist would only create false negatives without preventing any real
// false positive.
const TICKER_STOPLIST = new Set([
  'LLC', 'LLP', 'LP', 'INC', 'CORP', 'CO', 'LTD', 'THE', 'ETF', 'REIT',
  'EXCHANGED', 'RECEIVED', 'PARTIAL', 'FULL', 'NEW', 'OLD',
]);

const TICKER_TOKEN = /^[A-Z]{1,5}(\.[A-Z])?$/;

function isPlausibleTicker(candidate: string): boolean {
  return TICKER_TOKEN.test(candidate) && !TICKER_STOPLIST.has(candidate);
}

function extractTickerFromAssetName(assetName: string): string | null {
  const name = assetName.trim();
  if (!name) return null;

  // Leading "XXXX - Company Name" pattern, e.g. "EA - Electronic Arts Inc"
  const leadingMatch = name.match(/^([A-Z]{1,5}(?:\.[A-Z])?)\s*-\s*\S/);
  if (leadingMatch && isPlausibleTicker(leadingMatch[1]!)) {
    return leadingMatch[1]!;
  }

  // One or more "(XXXX)" parenthesized groups. A parenthesized group whose
  // content isn't purely 1-5 uppercase letters (+ optional ".X" suffix) —
  // e.g. "(Austin, TX)" or "(New York, NY)" — never matches this regex at
  // all, so free-text city/state addresses are excluded structurally, not
  // just by the stoplist. Exchange rows can carry multiple tickers (given
  // asset, then received asset) — take the first plausible one, which
  // corresponds to the asset actually being reported.
  const parenMatches = name.matchAll(/\(([A-Z]{1,5}(?:\.[A-Z])?)\)/g);
  for (const m of parenMatches) {
    const candidate = m[1]!;
    if (isPlausibleTicker(candidate)) return candidate;
  }

  return null;
}

// ─── Asset subtype derivation ──────────────────────────────────────────────────
// Senate EFD's own "Asset Type" field has a limited checkbox set on the PTR
// form, and filers routinely mark ETFs/mutual funds as "Stock" — there's no
// distinct source signal, unlike House's PDF marker codes (ET/MF/ST). Only
// probe asset_name for a subtype when the source itself said "Stock": a row
// already typed "Other", "Non-Public Stock", etc. gets a null subtype, since
// that source label is presumably more specific than a name-text guess.
const ETF_PATTERN = /\bETF\b/;
const FUND_PATTERN = /\b(?:Mutual\s+|Index\s+)?Fund\b/i;

function deriveAssetSubtype(assetType: string, assetName: string): 'ETF' | 'Mutual Fund' | null {
  if (assetType.trim().toLowerCase() !== 'stock') return null;

  if (ETF_PATTERN.test(assetName)) return 'ETF';
  if (FUND_PATTERN.test(assetName)) return 'Mutual Fund';
  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

type SkipReason =
  | 'missing_politician'
  | 'missing_both_dates'
  | 'missing_asset_name'
  | 'unrecognized_type';

function skipReason(raw: RawTransaction, type: 'buy' | 'sell' | 'exchange' | null): SkipReason | null {
  if (!raw.politician.trim()) return 'missing_politician';
  if (!raw.transaction_date.trim() && !raw.filing_date.trim()) return 'missing_both_dates';
  if (!raw.asset_name.trim()) return 'missing_asset_name';
  if (type === null) return 'unrecognized_type';
  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

// A 'scanned_unparsed' row is a placeholder for a filing submitted on paper
// (Senate EFD serves it as a scanned image/PDF at /search/view/paper/<id>/,
// not the structured HTML table electronic PTRs get) — every
// transaction-detail field is intentionally blank, so none of the normal
// validation/normalization below applies to it. Passed straight through so
// the filing isn't silently dropped from the dataset. See
// fetcher/senateFetcher.ts buildPaperPlaceholder.
function normalizeScannedPlaceholder(raw: RawTransaction): Transaction {
  return {
    politician: raw.politician.trim(),
    transaction_date: null,
    filing_date: raw.filing_date.trim(),
    ticker: null,
    asset_name: null,
    asset_type: null,
    asset_subtype: null,
    type: null,
    amount_min: null,
    amount_max: null,
    owner: null,
    source_id: raw.source_id,
    content_hash: '',
    filing_type: raw.filing_type,
    amendment_number: raw.amendment_number,
    parse_status: 'scanned_unparsed',
    pdf_url: raw.pdf_url,
    fetchedAt: '',
    lastModifiedAt: '',
    revisionCount: 0,
  };
}

export function normalize(raw: RawTransaction): Transaction | null {
  if (raw.parse_status === 'scanned_unparsed') return normalizeScannedPlaceholder(raw);

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
    ticker: normalizeTicker(raw.ticker) ?? extractTickerFromAssetName(raw.asset_name),
    asset_name: raw.asset_name.trim(),
    asset_type: raw.asset_type.trim(),
    asset_subtype: deriveAssetSubtype(raw.asset_type, raw.asset_name),
    type: type!,
    amount_min,
    amount_max,
    owner: normalizeOwner(raw.owner),
    source_id: raw.source_id,
    content_hash: '', // filled in by pipeline.ts alongside id, once amount_min/max etc. are final
    filing_type: raw.filing_type,
    amendment_number: raw.amendment_number,
    parse_status: 'ok',
    pdf_url: null,
    fetchedAt: '',      // filled in by pipeline.ts — first-seen or carried forward on revision
    lastModifiedAt: '', // filled in by pipeline.ts
    revisionCount: 0,   // filled in by pipeline.ts
  };
}

export function normalizeAll(raws: RawTransaction[]): Transaction[] {
  const results: Transaction[] = [];
  let skipped = 0;

  for (const raw of raws) {
    if (raw.parse_status === 'scanned_unparsed') {
      results.push(normalizeScannedPlaceholder(raw));
      continue;
    }

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
