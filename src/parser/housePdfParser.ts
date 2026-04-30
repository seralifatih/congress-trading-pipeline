import type { RawTransaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('housePdfParser');

// House PTR PDF format (post-2020, text-extractable):
// Header lines, then a table where each transaction is one row.
// Rows look roughly like:
//   "1  SP  Apple Inc (AAPL) [ST]  P  04/15/2026  04/20/2026  $1,001 - $15,000"
// or split across lines depending on PDF generator.
//
// We collapse the text to single-line per row and regex out the fields.

interface ParseInput {
  text: string;
  member: string;
  filingDate: string; // already YYYY-MM-DD
  docId: string;
}

const ASSET_TYPE_MAP: Record<string, string> = {
  ST: 'Stock',
  OP: 'Stock Option',
  GS: 'Government Security',
  MF: 'Mutual Fund',
  ET: 'ETF',
  CT: 'Cryptocurrency',
  CS: 'Corporate Bond',
  MS: 'Municipal Security',
  OT: 'Other',
};

const OWNER_MAP: Record<string, string> = {
  SP: 'spouse',
  DC: 'child',
  JT: 'joint',
  '--': 'self',
};

const TYPE_MAP: Record<string, string> = {
  P: 'Purchase',
  S: 'Sale (Full)',
  'S (partial)': 'Sale (Partial)',
  E: 'exchange',
};

// Match a transaction row. Tolerant of whitespace + line breaks.
// Capture: index, owner, asset (name + optional ticker + optional [TYPE]),
// trade type (P/S/S (partial)), trade date, notification date, amount range.
const ROW_RE =
  /(\d+)\s+(SP|DC|JT|--)?\s*(.+?)\s+\[([A-Z]{2})\]\s+(P|S\s*\(partial\)|S|E)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+\$([\d,]+)\s*-\s*\$([\d,]+)/gi;

const TICKER_RE = /\(([A-Z][A-Z0-9.\-]{0,5})\)/;

export function parseHousePtrText(input: ParseInput): RawTransaction[] {
  // Collapse multi-line wraps: replace any whitespace run with single space
  const flat = input.text.replace(/\s+/g, ' ');
  const out: RawTransaction[] = [];

  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = ROW_RE.exec(flat)) !== null) {
    count++;
    const [, idxStr, ownerCode, assetField, assetTypeCode, typeCode, txDate, , amountLow, amountHigh] = m;

    const owner = OWNER_MAP[ownerCode ?? '--'] ?? 'self';
    const assetType = ASSET_TYPE_MAP[assetTypeCode ?? 'OT'] ?? 'Other';
    const tickerMatch = (assetField ?? '').match(TICKER_RE);
    const ticker = tickerMatch?.[1] ?? '';
    const assetName = (assetField ?? '').replace(TICKER_RE, '').trim();

    out.push({
      politician: input.member,
      transaction_date: txDate ?? '',
      filing_date: input.filingDate,
      ticker,
      asset_name: assetName,
      asset_type: assetType,
      type: TYPE_MAP[(typeCode ?? '').toUpperCase().replace(/\s+/g, ' ')] ?? typeCode ?? '',
      amount: `$${amountLow} - $${amountHigh}`,
      owner,
      source_id: `house_${input.docId}_${idxStr}`,
      raw_json: {
        source: 'house',
        doc_id: input.docId,
        row_index: idxStr,
        owner_code: ownerCode,
        asset_type_code: assetTypeCode,
        type_code: typeCode,
      },
    });
  }

  if (count === 0) {
    log.warn(`House PTR ${input.docId}: no rows matched (likely scanned PDF — needs OCR)`);
  } else {
    log.info(`House PTR ${input.docId}: ${count} transactions parsed`);
  }
  return out;
}
