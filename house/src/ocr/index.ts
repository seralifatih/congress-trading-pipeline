// OCR fallback entry point for House PTR filings with no PDF text layer.
//
// Engine choice: HYBRID. Asset names (textOcr.ts) use tesseract.js (pure
// JS/WASM, npm-only) — no Dockerfile change, and no reliability problem was
// ever found on that field. Date and owner cells (dateOcr.ts, ownerOcr.ts)
// use the native Tesseract CLI, one process per read — see
// tesseractCli.ts's header comment for why: a byte-for-byte diagnosis
// proved tesseract.js itself misreads certain images that the CLI reads
// correctly given IDENTICAL input bytes (same SHA256). This was measured on
// a real filing, not theoretical: the exact PNG that made tesseract.js
// output "71/5/2026" for a clearly-legible "7/5/2026" was regenerated
// byte-for-byte in isolation, fed to a fresh tesseract.js worker (still
// wrong), then fed to the native CLI (correct) — repeated 3-for-3 on other
// disagreeing cells found in the same run. The original tradeoff analysis
// (CLI is faster but needs `apt-get install tesseract-ocr` in the
// Dockerfile — see git history on this comment) is superseded: correctness
// on fields the all-or-nothing policy depends on matters more than avoiding
// that one Dockerfile line, once the defect was proven rather than
// suspected. PDF rasterization (ocr/rasterize.ts) still uses pdfjs-dist +
// @napi-rs/canvas (no reliability issue found there).
//
// All-or-nothing policy (per product decision): if ANY row in a filing
// fails validation, the ENTIRE filing reverts to a scanned_unparsed
// placeholder — never a partial set of OCR rows. Confirmed and correct
// data only, or none; no silent partial coverage that could look like a
// complete filing when it isn't.
import type { RawTransaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';
import { rasterizePdf } from './rasterize.js';
import { matchesTemplate as matchesMccaulTemplate, extractMccaulRows, type OcrRow } from './mccaulTemplate.js';
import { AMOUNT_COLUMN_RANGES } from './amountRanges.js';

const log = makeLogger('ocr');

const TYPE_MAP: Record<string, string> = {
  Purchase: 'Purchase',
  Sale: 'Sale (Full)',
  Exchange: 'exchange',
};

// MM/DD/YYYY or M/D/YYYY — the McCaul template's own date format (see
// mccaulTemplate.ts's sampled OCR output, e.g. "06/26/2026", "7/5/2026").
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function normalizeOcrDate(raw: string): string | null {
  const m = raw.trim().match(DATE_RE);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const month = mm!.padStart(2, '0');
  const day = dd!.padStart(2, '0');
  return `${yyyy}-${month}-${day}`;
}

interface RowValidation {
  pass: boolean;
  reasons: string[];
}

// Validation rules, per spec: amount must match a known bracket; both dates
// valid and not after filing_date; type in {P, S, E} (this template has no
// "S (partial)" cell — see mccaulTemplate.ts's 3-column TYPE_COLUMNS);
// owner must be a readable code from {self, spouse, joint, dependent} — see
// ownerOcr.ts, which already restricts its output to exactly this set (or
// null for unreadable), so the check here is just "was it readable at all";
// ticker, if present, 1-5 uppercase letters — this template has no ticker
// field at all (see ocr/index.ts's mapRow), so that rule is vacuous here.
function validateRow(row: OcrRow, filingDateIso: string): RowValidation {
  const reasons: string[] = [];

  if (!row.amountColumn || !AMOUNT_COLUMN_RANGES[row.amountColumn]) {
    reasons.push('amount_no_column_detected');
  } else if (row.amountConfidence < 0.3) {
    reasons.push('amount_low_confidence');
  }

  const txDate = normalizeOcrDate(row.transactionDateRaw);
  const notifDate = normalizeOcrDate(row.notificationDateRaw);
  if (!txDate) reasons.push('transaction_date_invalid');
  if (!notifDate) reasons.push('notification_date_invalid');
  if (txDate && txDate > filingDateIso) reasons.push('transaction_date_after_filing');
  if (notifDate && notifDate > filingDateIso) reasons.push('notification_date_after_filing');
  // Chronological consistency: a transaction must be notified on or after
  // the day it happened, and both must precede the filing that discloses
  // them. This catches a specific OCR failure mode dateOcr.ts's shape+
  // calendar validation alone can't: a date that OCRs as a well-formed,
  // real calendar date but is still WRONG (e.g. right month/day, wrong
  // digit somewhere that still lands within the filing-year window) — out-
  // of-order dates are a strong signal of that.
  if (txDate && notifDate && txDate > notifDate) reasons.push('transaction_date_after_notification');

  if (!row.type) reasons.push('type_invalid');
  if (!row.assetName.trim()) reasons.push('asset_name_empty');
  if (row.ownerCode === null) reasons.push('owner_unreadable');

  return { pass: reasons.length === 0, reasons };
}

interface MapRowInput {
  row: OcrRow;
  member: string;
  filingDate: string;
  docId: string;
  pdfUrl: string;
  rowIndex: number;
}

function mapRow({ row, member, filingDate, docId, pdfUrl, rowIndex }: MapRowInput): RawTransaction {
  const range = row.amountColumn ? AMOUNT_COLUMN_RANGES[row.amountColumn] : null;
  const amount = range ? (range.max !== null ? `$${range.min} - $${range.max}` : `$${range.min}+`) : '';

  return {
    politician: member,
    transaction_date: normalizeOcrDate(row.transactionDateRaw) ?? '',
    filing_date: filingDate,
    // This template has no dedicated ticker field (plain-text asset names
    // like "FID ADV FLOATING RATE HIGH INCOME Z") — per product decision,
    // left null/empty rather than attempting extraction from asset_name
    // text, unlike the typed-PDF parser's extractTickerFromAssetName
    // fallback in normalize.ts.
    ticker: '',
    asset_name: row.assetName,
    asset_type: '', // not derivable from this template — no marker/type code like the typed PDFs
    type: row.type ? (TYPE_MAP[row.type] ?? '') : '',
    amount,
    // row.ownerCode is already one of 'self'|'spouse'|'joint'|'child' (see
    // ownerOcr.ts) by the time a row reaches here — validateRow rejects the
    // whole filing before mapRow runs if it was null (unreadable), so this
    // is never actually 'self'-as-a-fallback-guess in a row that shipped.
    owner: row.ownerCode ?? 'self',
    source_id: `house_${docId}_ocr_${rowIndex}`,
    filing_id: docId,
    filing_type: null, // this template has no per-row filing-status comment line
    parse_status: 'ocr',
    pdf_url: pdfUrl,
    ocr_confidence: Math.round(Math.min(row.textConfidence, row.amountConfidence * 100)),
    raw_json: {
      source: 'house',
      doc_id: docId,
      template: 'mccaul',
      row_index: rowIndex,
      amount_column: row.amountColumn,
      amount_confidence: row.amountConfidence,
      text_confidence: row.textConfidence,
    },
  };
}

export interface OcrAttemptResult {
  matched: boolean; // did any known template's page-size check match?
  succeeded: boolean; // matched AND every row passed validation
  rows: RawTransaction[]; // only populated when succeeded
}

// Attempts OCR recovery for one scanned filing. Tries each known template in
// turn (currently: McCaul only — see mccaulTemplate.ts). A template "claims"
// a filing by its rasterized page size; if claimed but extraction or
// validation fails for even one row, the whole filing is rejected (matched:
// true, succeeded: false) so the caller keeps it as scanned_unparsed rather
// than emitting a wrong number — never a partial per-row fallback.
export async function attemptOcr(
  pdfBuffer: Buffer,
  member: string,
  filingDate: string,
  docId: string,
  pdfUrl: string,
): Promise<OcrAttemptResult> {
  let pages;
  try {
    pages = await rasterizePdf(pdfBuffer);
  } catch (err) {
    log.warn(`House PTR ${docId}: rasterization failed, skipping OCR: ${err instanceof Error ? err.message : String(err)}`);
    return { matched: false, succeeded: false, rows: [] };
  }
  if (pages.length === 0) return { matched: false, succeeded: false, rows: [] };

  const first = pages[0]!;
  if (!matchesMccaulTemplate(first.widthPx, first.heightPx)) {
    return { matched: false, succeeded: false, rows: [] };
  }

  log.info(`House PTR ${docId}: page size matches McCaul template (${first.widthPx}x${first.heightPx}), attempting OCR`);

  const filingYear = parseInt(filingDate.slice(0, 4), 10);
  const ocrRows = await extractMccaulRows(pages, filingYear);
  if (ocrRows === null) {
    log.warn(`House PTR ${docId}: page size matched but column layout not found — treating as unmatched`);
    return { matched: false, succeeded: false, rows: [] };
  }
  if (ocrRows.length === 0) {
    log.warn(`House PTR ${docId}: matched McCaul template but extracted zero rows`);
    return { matched: true, succeeded: false, rows: [] };
  }

  const failures: { rowIndex: number; reasons: string[] }[] = [];
  ocrRows.forEach((row, i) => {
    const v = validateRow(row, filingDate);
    if (!v.pass) failures.push({ rowIndex: i, reasons: v.reasons });
  });

  if (failures.length > 0) {
    log.warn(
      `House PTR ${docId}: ${failures.length}/${ocrRows.length} OCR row(s) failed validation — ` +
      `rejecting entire filing (all-or-nothing policy), reverting to scanned_unparsed. ` +
      `First failure: row ${failures[0]!.rowIndex} (${failures[0]!.reasons.join(', ')})`,
    );
    return { matched: true, succeeded: false, rows: [] };
  }

  const rawRows = ocrRows.map((row, i) => mapRow({ row, member, filingDate, docId, pdfUrl, rowIndex: i }));
  log.info(`House PTR ${docId}: OCR recovered ${rawRows.length} row(s), all passed validation`);
  return { matched: true, succeeded: true, rows: rawRows };
}

export { terminateOcrWorker } from './textOcr.js';
