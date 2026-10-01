const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collapseCrossFilingDuplicates, computeContentHash } = require('../dist/utils/dedup.js');

// Fixtures mirror real rows from run vyb2mlSRWe0HiZSeT (dataset
// TkHVegU8mtzp6xXgU):
//   - Boozman, 2026-08-17: original 4a558db2 and Amendment 1 4184cc9a list the
//     same six trades (identical content_hash on every row).
//   - Tuberville, 2024-10-29 block: Amendment 1 cce52b36 and Amendment 2
//     2b076d77 (both filed 2026-08-05) each carry the same 12 trades.
//   - Blumenthal 9e2ff733: one filing listing identical tranches (8 identical
//     rows for MH Built to Last LLC on 2026-08-24) — legitimate, must be kept.

function row(overrides = {}) {
  return {
    politician: 'John Boozman', transaction_date: '2026-08-17', filing_date: '2026-08-17', ticker: 'APTV',
    asset_name: 'Aptiv PLC', asset_type: 'Stock', asset_subtype: null, type: 'sell', amount_min: 1001, amount_max: 15000,
    owner: 'self', source_id: 'x|0', filing_id: 'x', content_hash: '', filing_type: 'original', amendment_number: null,
    supersedes_filing_id: null, is_superseded: false, parse_status: 'ok', pdf_url: null,
    fetchedAt: '', lastModifiedAt: '', revisionCount: 0, ...overrides,
  };
}

const TICKERS = ['APTV', 'PYPL', 'SPYM', 'EL', 'CVX', 'AAPL'];

function filingRows({ filing_id, filing_type, amendment_number = null, filing_date = '2026-08-17', politician = 'John Boozman', tickers = TICKERS }) {
  return tickers.map((ticker, i) =>
    row({ filing_id, filing_type, amendment_number, filing_date, politician, ticker, asset_name: `${ticker} Corp`, source_id: `${filing_id}|${i}` }),
  );
}

test('fixture sanity: the same trade in two filings has the same content_hash', () => {
  const [a] = filingRows({ filing_id: 'orig', filing_type: 'original' });
  const [b] = filingRows({ filing_id: 'amend', filing_type: 'amendment', amendment_number: 1 });
  assert.equal(computeContentHash(a), computeContentHash(b));
  assert.notEqual(a.source_id, b.source_id);
});

test('Boozman: original + Amendment 1 list the same trades -> the amendment copy is kept, original copy dropped', () => {
  // Listing order is newest-first; here the amendment is listed first.
  const rows = [
    ...filingRows({ filing_id: '4184cc9a', filing_type: 'amendment', amendment_number: 1 }),
    ...filingRows({ filing_id: '4a558db2', filing_type: 'original' }),
  ];
  const r = collapseCrossFilingDuplicates(rows);
  assert.equal(r.rows.length, 6);
  assert.equal(r.duplicatesRemoved, 6);
  assert.ok(r.rows.every((t) => t.filing_id === '4184cc9a'), 'only the amendment\'s rows survive');
  assert.ok(r.rows.every((t) => t.filing_type === 'amendment' && t.amendment_number === 1), 'filing_type/amendment_number preserved');
  assert.ok(r.rows.every((t) => t.supersedes_filing_id === '4a558db2'), 'amendment points at the filing it re-lists');
});

test('the amendment survives even when the original is listed first / filed later in the batch', () => {
  const rows = [
    ...filingRows({ filing_id: '4a558db2', filing_type: 'original' }),
    ...filingRows({ filing_id: '4184cc9a', filing_type: 'amendment', amendment_number: 1 }),
  ];
  const r = collapseCrossFilingDuplicates(rows);
  assert.ok(r.rows.every((t) => t.filing_id === '4184cc9a'));
});

test('Tuberville: Amendment 1 vs Amendment 2 with identical rows -> Amendment 2 kept', () => {
  const rows = [
    ...filingRows({ filing_id: '2b076d77', filing_type: 'amendment', amendment_number: 2, filing_date: '2026-08-05', politician: 'Thomas H Tuberville' }),
    ...filingRows({ filing_id: 'cce52b36', filing_type: 'amendment', amendment_number: 1, filing_date: '2026-08-05', politician: 'Thomas H Tuberville' }),
  ];
  const r = collapseCrossFilingDuplicates(rows);
  assert.equal(r.rows.length, 6);
  assert.ok(r.rows.every((t) => t.filing_id === '2b076d77' && t.amendment_number === 2));
  assert.ok(r.rows.every((t) => t.supersedes_filing_id === 'cce52b36'));
});

test('a partly-overlapping original keeps its non-shared rows and is flagged is_superseded', () => {
  const rows = [
    ...filingRows({ filing_id: 'amend', filing_type: 'amendment', amendment_number: 1, tickers: ['APTV', 'PYPL'] }),
    ...filingRows({ filing_id: 'orig', filing_type: 'original', tickers: ['APTV', 'PYPL', 'EL'] }),
  ];
  const r = collapseCrossFilingDuplicates(rows);
  assert.equal(r.duplicatesRemoved, 2);
  const orig = r.rows.filter((t) => t.filing_id === 'orig');
  assert.equal(orig.length, 1);
  assert.equal(orig[0].ticker, 'EL');
  assert.equal(orig[0].is_superseded, true);
  assert.ok(r.rows.filter((t) => t.filing_id === 'amend').every((t) => t.supersedes_filing_id === 'orig' && t.is_superseded === false));
});

test('identical rows WITHIN one filing are legitimate tranches and are never removed (Blumenthal)', () => {
  const tranche = (i) => row({ politician: 'Richard Blumenthal', filing_id: '9e2ff733', ticker: null, asset_name: 'MH Built to Last LLC', owner: 'spouse', source_id: `9e2ff733|${i}` });
  const rows = [0, 1, 2, 3, 4, 5, 6, 7].map(tranche);
  const r = collapseCrossFilingDuplicates(rows);
  assert.equal(r.rows.length, 8);
  assert.equal(r.duplicatesRemoved, 0);
});

test('tranche multiplicity is preserved: the winning filing keeps ALL its copies of a repeated trade', () => {
  const t = (filing_id, filing_type, amendment_number, i) =>
    row({ filing_id, filing_type, amendment_number, ticker: 'EL', asset_name: 'EL Corp', source_id: `${filing_id}|${i}` });
  const rows = [t('amend', 'amendment', 1, 0), t('amend', 'amendment', 1, 1), t('orig', 'original', null, 0), t('orig', 'original', null, 1)];
  const r = collapseCrossFilingDuplicates(rows);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((x) => x.filing_id === 'amend'));
});

test('no supersession is claimed when two filings share no trade (not determinable)', () => {
  const rows = [
    ...filingRows({ filing_id: 'a1', filing_type: 'amendment', amendment_number: 1, tickers: ['APTV'] }),
    ...filingRows({ filing_id: 'o1', filing_type: 'original', tickers: ['PYPL'] }),
  ];
  const r = collapseCrossFilingDuplicates(rows);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((t) => !t.supersedes_filing_id && !t.is_superseded));
});

test('different filers never collapse into each other, even with identical trade fields', () => {
  const rows = [
    ...filingRows({ filing_id: 'a', filing_type: 'original', politician: 'John Boozman' }),
    ...filingRows({ filing_id: 'b', filing_type: 'original', politician: 'Tim Scott' }),
  ];
  const r = collapseCrossFilingDuplicates(rows);
  assert.equal(r.rows.length, 12);
});

test('two ORIGINAL filings of the same trades (accidental re-file) collapse to one copy, with no supersession claim', () => {
  const rows = [
    ...filingRows({ filing_id: 'newer', filing_type: 'original', filing_date: '2026-09-11' }),
    ...filingRows({ filing_id: 'older', filing_type: 'original', filing_date: '2026-09-10' }),
  ];
  const r = collapseCrossFilingDuplicates(rows);
  assert.equal(r.rows.length, 6);
  assert.ok(r.rows.every((t) => t.filing_id === 'newer'));
  assert.ok(r.rows.every((t) => !t.supersedes_filing_id));
});

test('dropDuplicates:false (includeDuplicates) keeps every row but still annotates supersession', () => {
  const rows = [
    ...filingRows({ filing_id: 'amend', filing_type: 'amendment', amendment_number: 1 }),
    ...filingRows({ filing_id: 'orig', filing_type: 'original' }),
  ];
  const r = collapseCrossFilingDuplicates(rows, { dropDuplicates: false });
  assert.equal(r.rows.length, 12);
  assert.equal(r.duplicatesRemoved, 0);
  assert.ok(r.rows.filter((t) => t.filing_id === 'amend').every((t) => t.supersedes_filing_id === 'orig'));
  assert.ok(r.rows.filter((t) => t.filing_id === 'orig').every((t) => t.is_superseded === true));
});

test('placeholder rows pass through untouched', () => {
  const ph = row({ parse_status: 'scanned_unparsed', transaction_date: null, ticker: null, asset_name: null, type: null, amount_min: null, amount_max: null, owner: null });
  const r = collapseCrossFilingDuplicates([ph, ph]);
  assert.equal(r.rows.length, 2);
});
