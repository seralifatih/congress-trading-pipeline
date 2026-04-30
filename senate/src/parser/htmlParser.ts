import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { RawTransaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('htmlParser');

// ─── Column index map ─────────────────────────────────────────────────────────
// Senate EFD search results table column order (observed, 0-indexed):
//   0: Senator name / filer
//   1: Filing date (date the PTR was submitted)
//   2: Transaction date
//   3: Owner
//   4: Ticker
//   5: Asset name
//   6: Asset type
//   7: Transaction type  (raw: "Purchase", "Sale (Full)", "Sale (Partial)")
//   8: Amount            (raw: "$1,001 - $15,000")
//
// The HTML table may not always be consistent. We use header text matching as
// the primary strategy and fall back to positional index as a secondary.

const HEADER_MAP: Record<string, keyof ColIndices> = {
  senator: 'politician',
  filer: 'politician',
  name: 'politician',
  'transaction date': 'transaction_date',
  'date of transaction': 'transaction_date',
  'filing date': 'filing_date',
  'date filed': 'filing_date',
  owner: 'owner',
  ticker: 'ticker',
  asset: 'asset_name',
  'asset name': 'asset_name',
  'asset type': 'asset_type',
  type: 'type',
  'transaction type': 'type',
  amount: 'amount',
};

interface ColIndices {
  politician: number;
  transaction_date: number;
  filing_date: number;
  owner: number;
  ticker: number;
  asset_name: number;
  asset_type: number;
  type: number;
  amount: number;
}

const POSITIONAL_DEFAULTS: ColIndices = {
  politician: 0,
  filing_date: 1,
  transaction_date: 2,
  owner: 3,
  ticker: 4,
  asset_name: 5,
  asset_type: 6,
  type: 7,
  amount: 8,
};

function cell(cells: Cheerio<AnyNode>, idx: number, $: CheerioAPI): string {
  const el = cells.eq(idx);
  if (!el || el.length === 0) return '';
  return el.text().trim().replace(/\s+/g, ' ');
}

function buildColIndices(
  headerRow: Cheerio<AnyNode>,
  $: CheerioAPI,
): ColIndices {
  const indices = { ...POSITIONAL_DEFAULTS };
  let matched = 0;

  headerRow.find('th, td').each((i, el) => {
    const text = $(el).text().trim().toLowerCase();
    const key = HEADER_MAP[text];
    if (key) {
      indices[key] = i;
      matched++;
    }
  });

  if (matched === 0) {
    log.warn('No header columns matched — using positional fallback');
  } else {
    log.info(`Matched ${matched} header columns`);
  }

  return indices;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export function parseHtml(html: string): RawTransaction[] {
  const $ = cheerio.load(html);
  const results: RawTransaction[] = [];

  // Try common table selectors used by Senate EFD
  const tableSelectors = [
    'table.table-striped',
    'table#filedReports',
    'table.efts-table',
    'table',
  ];

  let table: Cheerio<AnyNode> | null = null;
  for (const sel of tableSelectors) {
    const found = $(sel).first();
    if (found.length > 0) {
      table = found;
      log.info(`Found table with selector: ${sel}`);
      break;
    }
  }

  if (!table) {
    log.warn('No transaction table found in HTML');
    return [];
  }

  const rows = table.find('tr');
  if (rows.length < 2) {
    log.warn(`Table has ${rows.length} rows — no data rows`);
    return [];
  }

  // Build column index map from first row
  const cols = buildColIndices(rows.first(), $);

  let skipped = 0;
  rows.each((rowIdx, rowEl) => {
    if (rowIdx === 0) return; // header row

    const cells = $(rowEl).find('td');
    if (cells.length === 0) return; // skip sub-headers / empty rows

    const politician = cell(cells, cols.politician, $);
    if (!politician) {
      skipped++;
      return;
    }

    // Derive a stable source_id from content since HTML has no Elasticsearch _id
    const sourceId = [
      politician,
      cell(cells, cols.transaction_date, $),
      cell(cells, cols.asset_name, $),
      cell(cells, cols.amount, $),
    ]
      .join('|')
      .replace(/\s+/g, ' ')
      .trim();

    const raw: Record<string, unknown> = {};
    cells.each((i, el) => {
      raw[`col_${i}`] = $(el).text().trim();
    });

    results.push({
      politician,
      transaction_date: cell(cells, cols.transaction_date, $),
      filing_date: cell(cells, cols.filing_date, $),
      ticker: cell(cells, cols.ticker, $),
      asset_name: cell(cells, cols.asset_name, $),
      asset_type: cell(cells, cols.asset_type, $),
      type: cell(cells, cols.type, $),
      amount: cell(cells, cols.amount, $),
      owner: cell(cells, cols.owner, $),
      source_id: sourceId,
      raw_json: raw,
    });
  });

  log.info(`parseHtml: ${results.length} rows extracted, ${skipped} skipped`);
  return results;
}
