import { parse as parseDate, isValid, format } from 'date-fns';
import type { RawTransaction, Transaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';
import { normalizeNameCase } from '../utils/names.js';

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

// The source's ticker cell is "--" when blank, and occasionally carries
// artifacts ("-- AMCR" on an exchange row) or a company-name abbreviation
// instead of a ticker ("COLPAL"). Cleaning rules, in order:
//   1. split on whitespace, drop tokens with no letter/digit ("--", "*")
//   2. trim leading/trailing punctuation from each remaining token
//   3. exactly one token must remain — several is ambiguous -> null
//   4. a token whose base (the part before any ".X"/"-X" class suffix) is
//      longer than 5 characters is not a US ticker (those are 1-5 letters) —
//      it's a company-name abbreviation -> null, asset_name is kept as-is.
// Nothing here ever invents a ticker.
const MAX_TICKER_BASE_LEN = 5;

function normalizeTicker(raw: string): string | null {
  const tokens = raw
    .toUpperCase()
    .split(/\s+/)
    .filter((tok) => /[A-Z0-9]/.test(tok))
    .map((tok) => tok.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, ''));
  if (tokens.length !== 1) return null;

  const t = tokens[0]!;
  if (t === 'N/A' || t === 'NA') return null;
  const base = t.split(/[.\-]/)[0]!;
  if (base.length > MAX_TICKER_BASE_LEN) return null;
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

  // Leading "XXXX - Company Name" pattern, e.g. "EA - Electronic Arts Inc".
  // Whitespace BEFORE the dash is required: a hyphen glued to the word is
  // part of a hyphenated name, not a delimiter — "ROLLS-ROYCE HOLDINGS PLC
  // ADR" must not yield the "ticker" ROLLS.
  const leadingMatch = name.match(/^([A-Z]{1,5}(?:\.[A-Z])?)\s+-\s*\S/);
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

// ─── Exchange rows ────────────────────────────────────────────────────────────
// An Exchange swaps one asset for another, and the source describes both in
// ONE row: asset_name reads "<given> (Exchanged) <received> (Received)" and the
// ticker cell can carry both tickers, given first — "-- AMCR" is "no ticker for
// the given asset, AMCR for the received one" (Wyden, BERY -> AMCR). Putting
// the received ticker in `ticker` next to the given asset's name was
// misleading and broke ticker filters, so `ticker` is the GIVEN asset's and
// the received asset gets its own fields. Nothing is guessed: every value
// comes from the source's ticker cell or from a ticker the asset_name text
// states ("(AVB)" / "XXXX - Name").

const EXCHANGED_MARKER = /\(\s*Exchanged\s*\)/i;
const RECEIVED_SUFFIX = /\(\s*Received\s*\)\s*$/i;

interface ExchangeParts {
  ticker: string | null;
  received_ticker: string | null;
  received_asset_name: string | null;
}

function cleanTickerToken(tok: string): string | null {
  if (!/[A-Za-z0-9]/.test(tok)) return null; // "--"
  const t = tok.toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
  if (!t || t === 'N/A' || t === 'NA') return null;
  return t.split(/[.\-]/)[0]!.length > MAX_TICKER_BASE_LEN ? null : t;
}

function parseExchange(rawTicker: string, assetName: string): ExchangeParts {
  const name = assetName.trim();
  const marker = name.match(EXCHANGED_MARKER);
  let givenPart = name;
  let receivedPart: string | null = null;
  if (marker && marker.index !== undefined) {
    givenPart = name.slice(0, marker.index).trim();
    receivedPart = name.slice(marker.index + marker[0].length).replace(RECEIVED_SUFFIX, '').trim() || null;
  }

  const nameGiven = extractTickerFromAssetName(givenPart);
  const nameReceived = receivedPart ? extractTickerFromAssetName(receivedPart) : null;

  // Ticker cell: whitespace-separated, given first; "--" holds a slot open.
  const cell = rawTicker.trim().split(/\s+/).filter((t) => t.length > 0).map(cleanTickerToken);
  let cellGiven: string | null = null;
  let cellReceived: string | null = null;
  if (cell.length >= 2) {
    cellGiven = cell[0] ?? null;
    cellReceived = cell[1] ?? null;
  } else if (cell.length === 1 && cell[0]) {
    // A lone ticker belongs to the received asset only if the text says so.
    if (nameReceived === cell[0] && nameGiven !== cell[0]) cellReceived = cell[0];
    else cellGiven = cell[0];
  }

  let received_asset_name: string | null = receivedPart;
  const received_ticker = cellReceived ?? nameReceived;
  if (received_asset_name && received_ticker) {
    // Drop a leading "XXXX - " ticker prefix; the ticker has its own field.
    received_asset_name = received_asset_name.replace(
      new RegExp('^' + received_ticker.replace(/[.]/g, '\\.') + '\\s+-\\s*'),
      '',
    ).trim() || null;
  }

  return {
    // Without the "(Exchanged)" marker we can't tell the halves apart; fall
    // back to the first plausible ticker in the name, as before.
    ticker: cellGiven ?? nameGiven,
    received_ticker,
    received_asset_name,
  };
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

// A 'fetch_failed', 'scanned_unparsed', or 'parse_failed' row is a
// placeholder for a filing that produced no transaction-detail data —
// respectively: the PTR detail-page fetch itself failed (senateFetcher.ts),
// the filing was submitted on paper (Senate EFD serves it as a scanned
// image/PDF at /search/view/paper/<id>/, not the structured HTML table
// electronic PTRs get), or the /ptr/<uuid>/ page fetched fine but had zero
// parseable table rows (a parser bug or Senate EFD layout change) — every
// transaction-detail field is intentionally blank, so none of the normal
// validation/normalization below applies to it. Passed straight through so
// the filing isn't silently dropped from the dataset. See
// fetcher/senateFetcher.ts buildPaperPlaceholder / buildFetchFailedPlaceholder
// / buildParseFailedPlaceholder.
const PLACEHOLDER_STATUSES = new Set(['fetch_failed', 'scanned_unparsed', 'parse_failed']);

function isPlaceholderStatus(status: string): status is 'fetch_failed' | 'scanned_unparsed' | 'parse_failed' {
  return PLACEHOLDER_STATUSES.has(status);
}

function normalizePlaceholder(
  raw: RawTransaction,
  parse_status: 'fetch_failed' | 'scanned_unparsed' | 'parse_failed',
): Transaction {
  return {
    politician: normalizeNameCase(raw.politician),
    politician_raw: raw.politician.trim(),
    member_bioguide_id: null, // filled in by pipeline.ts from the roster
    // Same ISO conversion the parsed rows get — the listing's own
    // "MM/DD/YYYY" string used to pass through here untouched.
    filing_date: normalizeDate(raw.filing_date) ?? raw.filing_date.trim(),
    transaction_date: null,
    ticker: null,
    asset_name: null,
    received_ticker: null,
    received_asset_name: null,
    asset_type: null,
    asset_subtype: null,
    type: null,
    amount_min: null,
    amount_max: null,
    owner: null,
    source_id: raw.source_id,
    filing_id: raw.filing_id,
    content_hash: '',
    filing_type: raw.filing_type,
    amendment_number: raw.amendment_number,
    row_index_in_filing: 0, // a placeholder is its filing's only row
    supersedes_filing_id: null,
    is_superseded: false,
    parse_status,
    pdf_url: raw.pdf_url,
    fetchedAt: '',
    lastModifiedAt: '',
    revisionCount: 0,
  };
}

export function normalize(raw: RawTransaction): Transaction | null {
  if (isPlaceholderStatus(raw.parse_status)) return normalizePlaceholder(raw, raw.parse_status);

  const type = normalizeType(raw.type);
  const reason = skipReason(raw, type);

  if (reason !== null) return null;

  const transaction_date = normalizeDate(raw.transaction_date);
  const filing_date = normalizeDate(raw.filing_date);

  // If both dates are present but both fail to parse, still reject
  if (transaction_date === null && filing_date === null) return null;

  const { amount_min, amount_max } = parseAmount(raw.amount);
  const exchange = type === 'exchange' ? parseExchange(raw.ticker, raw.asset_name) : null;

  return {
    politician: normalizeNameCase(raw.politician),
    politician_raw: raw.politician.trim(),
    member_bioguide_id: null, // filled in by pipeline.ts from the roster
    transaction_date: transaction_date ?? filing_date!,
    filing_date: filing_date ?? transaction_date!,
    ticker: exchange ? exchange.ticker : normalizeTicker(raw.ticker) ?? extractTickerFromAssetName(raw.asset_name),
    asset_name: raw.asset_name.trim(),
    received_ticker: exchange?.received_ticker ?? null,
    received_asset_name: exchange?.received_asset_name ?? null,
    asset_type: raw.asset_type.trim(),
    asset_subtype: deriveAssetSubtype(raw.asset_type, raw.asset_name),
    type: type!,
    amount_min,
    amount_max,
    owner: normalizeOwner(raw.owner),
    source_id: raw.source_id,
    filing_id: raw.filing_id,
    content_hash: '', // filled in by pipeline.ts alongside id, once amount_min/max etc. are final
    filing_type: raw.filing_type,
    amendment_number: raw.amendment_number,
    row_index_in_filing: raw.row_index_in_filing ?? null,
    supersedes_filing_id: null, // filled in by pipeline.ts (see utils/dedup.ts collapseCrossFilingDuplicates)
    is_superseded: false,
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
    if (isPlaceholderStatus(raw.parse_status)) {
      results.push(normalizePlaceholder(raw, raw.parse_status));
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
