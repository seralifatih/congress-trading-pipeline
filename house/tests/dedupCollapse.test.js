const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { collapseCrossFilingDuplicates, computeContentHash } = require('../dist/utils/dedup.js');
const { normalizeAll } = require('../dist/transformer/normalize.js');

// Run IDgg2nQSlsPoPxJhr (475 rows) had 15 "identical-looking" row pairs
// (Donalds, Franklin, ...). Checked against owner and content_hash first:
//   - 9 of 15 differ in `owner` (self vs spouse) -> different content_hash,
//     genuinely distinct rows (a joint account bought for self AND spouse);
//   - the other 6 share owner and content_hash but sit in the SAME filing,
//     i.e. repeated line items within one PTR;
//   - 0 spanned two filings.
// So nothing in that dataset was a true duplicate, and nothing may be removed.

function row(overrides = {}) {
  return {
    politician: 'Byron Donalds', transaction_date: '2026-06-05', filing_date: '2026-08-12', ticker: 'CDNS',
    asset_name: 'Cadence Design Systems, Inc. - Common Stock', asset_type: 'Stock', asset_subtype: null, type: 'buy',
    amount_min: 1001, amount_max: 15000, owner: 'self', source_id: 'house_20034968_0', filing_id: '20034968',
    content_hash: '', filing_type: 'original', amendment_number: null, supersedes_filing_id: null, is_superseded: false,
    parse_status: 'ok', pdf_url: 'x', ocr_confidence: null, fetchedAt: '', lastModifiedAt: '', revisionCount: 0, ...overrides,
  };
}

test('Donalds/Franklin pairs: same ticker/date/amount but owner self vs spouse -> different content_hash, both kept', () => {
  const a = row({ owner: 'self', source_id: 'house_20034968_0' });
  const b = row({ owner: 'spouse', source_id: 'house_20034968_1' });
  assert.notEqual(computeContentHash(a), computeContentHash(b));
  const r = collapseCrossFilingDuplicates([a, b]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.duplicatesRemoved, 0);
});

test('same owner, same filing, identical rows are repeated line items of one PTR -> kept (no cross-filing duplicate)', () => {
  const a = row({ source_id: 'house_20034968_0' });
  const b = row({ source_id: 'house_20034968_1' });
  assert.equal(computeContentHash(a), computeContentHash(b));
  assert.equal(collapseCrossFilingDuplicates([a, b]).rows.length, 2);
});

test('the same trade in two DIFFERENT filings is an exact duplicate: the later / amended filing\'s copy is kept', () => {
  const orig = row({ filing_id: 'orig', source_id: 'house_orig_0', filing_date: '2026-08-12' });
  const amended = row({ filing_id: 'amd', source_id: 'house_amd_0', filing_date: '2026-08-20', filing_type: 'amendment' });
  const r = collapseCrossFilingDuplicates([orig, amended]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].filing_id, 'amd');
  assert.equal(r.rows[0].filing_type, 'amendment');
  assert.equal(r.rows[0].supersedes_filing_id, 'orig');
  assert.equal(r.duplicatesRemoved, 1);
});

test('House labels amendments per ROW: a filing with any "Amended" row outranks an all-"New" one', () => {
  const mk = (filing_id, type, i, filing_date) => row({ filing_id, source_id: `house_${filing_id}_${i}`, filing_type: type, filing_date });
  // Same day, so only the amendment label can decide. The amended filing's FIRST row is labeled "original".
  const rows = [
    mk('plain', 'original', 0, '2026-08-12'),
    mk('mixed', 'original', 0, '2026-08-12'),
    mk('mixed', 'amendment', 1, '2026-08-12'),
  ];
  rows[2].ticker = 'ZTS';
  const r = collapseCrossFilingDuplicates(rows);
  assert.ok(r.rows.filter((t) => t.ticker === 'CDNS').every((t) => t.filing_id === 'mixed'));
  assert.equal(r.rows[0].supersedes_filing_id, 'plain');
});

test('includeDuplicates (dropDuplicates:false) keeps every copy but still annotates', () => {
  const orig = row({ filing_id: 'orig', source_id: 'house_orig_0' });
  const amended = row({ filing_id: 'amd', source_id: 'house_amd_0', filing_type: 'amendment' });
  const r = collapseCrossFilingDuplicates([amended, orig], { dropDuplicates: false });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows.find((t) => t.filing_id === 'orig').is_superseded, true);
});

test('different filers and placeholders are never collapsed; OCR rows count as real rows', () => {
  const a = row({ filing_id: 'a', politician: 'Byron Donalds' });
  const b = row({ filing_id: 'b', politician: 'Kevin Hern' });
  const ocr = row({ filing_id: 'c', parse_status: 'ocr', ticker: 'ZTS', asset_name: 'Zoetis Inc.', source_id: 'house_c_0' });
  const ph = row({ filing_id: 'd', parse_status: 'scanned_unparsed', transaction_date: null, ticker: null, source_id: 'house_d_scanned' });
  assert.equal(collapseCrossFilingDuplicates([a, b, ocr, ph, ph]).rows.length, 5);
});

// ─── Real-PDF check: owner is part of the content_hash only if parsed correctly ──

test('real PTR 20035134 (Hern): every row is JOINT — the glued "JT" owner code no longer leaks into asset_name', () => {
  const { parseHousePtrText } = require('../dist/parser/housePdfParser.js');
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', '20035134.txt'), 'utf8');
  const rows = normalizeAll(parseHousePtrText({ text, member: 'Kevin Hern', filingDate: '2026-08-05', docId: '20035134', pdfUrl: 'x' }));
  assert.equal(rows.length, 14);
  assert.ok(rows.every((t) => t.owner === 'joint'));
  assert.ok(rows.every((t) => !/^JT/.test(t.asset_name)));
});

// ─── row_index_in_filing ──────────────────────────────────────────────────────
// Donalds / Franklin pairs: repeated line items of one PTR share a content_hash.
// row_index_in_filing (0-based, source order) tells them apart without touching
// content_hash or id.

test('row_index_in_filing: 0-based, consecutive, deterministic on a real PTR (Hern 20035134)', () => {
  const { parseHousePtrText } = require('../dist/parser/housePdfParser.js');
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', '20035134.txt'), 'utf8');
  const parse = () => normalizeAll(parseHousePtrText({ text, member: 'Kevin Hern', filingDate: '2026-08-05', docId: '20035134', pdfUrl: 'x' }));
  const rows = parse();
  assert.deepEqual(rows.map((r) => r.row_index_in_filing), Array.from({ length: rows.length }, (_, i) => i));
  assert.deepEqual(parse().map((r) => r.row_index_in_filing), rows.map((r) => r.row_index_in_filing));
});

test('row_index_in_filing is not part of id or content_hash: identical rows keep one hash and distinct ids', () => {
  const { generateId } = require('../dist/utils/dedup.js');
  const raw = (i) => ({
    politician: 'Byron Donalds', transaction_date: '06/05/2026', filing_date: '2026-08-12', ticker: 'CDNS',
    asset_name: 'Cadence Design Systems, Inc. - Common Stock', asset_type: 'Stock', type: 'Purchase',
    amount: '$1,001 - $15,000', owner: 'self', source_id: `house_20034968_${i}`, filing_id: '20034968',
    filing_type: 'original', parse_status: 'ok', pdf_url: 'x', ocr_confidence: null, raw_json: {}, row_index_in_filing: i,
  });
  const [a, b] = [raw(0), raw(1)].map((r) => normalizeAll([r])[0]);
  assert.equal(computeContentHash(a), computeContentHash(b));
  assert.deepEqual([a.row_index_in_filing, b.row_index_in_filing], [0, 1]);
  const stripped = { ...a, row_index_in_filing: null };
  assert.equal(computeContentHash(a), computeContentHash(stripped));
  assert.equal(generateId(a), generateId(stripped));
  assert.notEqual(generateId(a), generateId(b));
});

test('placeholders have row_index_in_filing 0', () => {
  const ph = normalizeAll([{
    politician: 'Tom Cole', transaction_date: '', filing_date: '2026-07-21', ticker: '', asset_name: '', asset_type: '', type: '',
    amount: '', owner: '', source_id: 'house_1_scanned', filing_id: '1', filing_type: null, parse_status: 'scanned_unparsed',
    pdf_url: 'x', ocr_confidence: null, raw_json: {},
  }])[0];
  assert.equal(ph.row_index_in_filing, 0);
});
