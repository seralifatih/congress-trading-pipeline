const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  rowToFilingMeta,
  buildPaperPlaceholder,
  buildFetchFailedPlaceholder,
  parsePtrTransactions,
  collectFilings,
} = require('../dist/fetcher/senateFetcher.js');
const { normalize } = require('../dist/transformer/normalize.js');

function ptrRow(overrides = {}) {
  return [
    overrides.firstName ?? 'Jane',
    overrides.lastName ?? 'Doe',
    overrides.office ?? 'Senator',
    overrides.reportCell
      ?? '<a href="/search/view/ptr/abc12345-e1b2-411d-b562-8fe4c2a4f2a1/">Periodic Transaction Report</a>',
    overrides.filedDate ?? '09/17/2026',
  ];
}

function paperRow(overrides = {}) {
  return ptrRow({
    reportCell: '<a href="/search/view/paper/998877/">Periodic Transaction Report</a>',
    ...overrides,
  });
}

const NORMAL_TABLE_HTML = [
  '<html><body><table><tbody>',
  '<tr><td>1</td><td>08/14/2026</td><td>Self</td><td>EA</td>',
  '<td>Electronic Arts Inc.</td><td>Stock</td><td>Purchase</td>',
  '<td>$1,001 - $15,000</td><td></td></tr>',
  '</tbody></table></body></html>',
].join('');

const EMPTY_HTML = '<html><head><title>eFD: Report</title></head><body><p>No data</p></body></html>';

// ─── Listing classification: /ptr/ vs /paper/ link shape ──────────────────────

test('rowToFilingMeta classifies a /ptr/ link as docType "ptr"', () => {
  const meta = rowToFilingMeta(ptrRow());
  assert.ok(meta);
  assert.equal(meta.docType, 'ptr');
  assert.equal(meta.doc_id, 'abc12345-e1b2-411d-b562-8fe4c2a4f2a1');
});

test('rowToFilingMeta classifies a /paper/ link as docType "paper"', () => {
  const meta = rowToFilingMeta(paperRow());
  assert.ok(meta);
  assert.equal(meta.docType, 'paper');
  assert.equal(meta.doc_id, '998877');
});

test('rowToFilingMeta returns null for neither link shape', () => {
  const row = ptrRow({ reportCell: '<a href="/search/view/annual/xyz/">Annual Report</a>' });
  assert.equal(rowToFilingMeta(row), null);
});

// ─── Unknown link shape: counted and logged, never silently dropped ──────────

test('collectFilings counts an unrecognized link shape and records its URL', () => {
  const rows = [
    ptrRow(),
    paperRow(),
    ptrRow({ reportCell: '<a href="/search/view/annual/xyz/">Annual Report</a>' }),
  ];
  const examples = [];
  const result = collectFilings(rows, examples);

  assert.equal(result.filings.length, 2, 'the two recognized rows (ptr + paper) should still be collected');
  assert.equal(result.unknownCount, 1);
  assert.equal(examples.length, 1);
  assert.equal(examples[0], 'https://efdsearch.senate.gov/search/view/annual/xyz/');
});

test('collectFilings caps logged examples but keeps counting past the cap', () => {
  const unknownRows = Array.from({ length: 8 }, (_, i) =>
    ptrRow({ reportCell: `<a href="/search/view/annual/doc${i}/">Annual Report</a>` }),
  );
  const examples = [];
  const result = collectFilings(unknownRows, examples);

  assert.equal(result.unknownCount, 8, 'every unknown row should still be counted');
  assert.equal(examples.length, 5, 'only the first 5 example URLs should be captured');
});

test('a malformed row (missing cells) is not counted as an unknown doc type', () => {
  const malformedRow = ['Jane', 'Doe']; // too few cells to even read a link from
  const examples = [];
  const result = collectFilings([malformedRow], examples);

  assert.equal(result.filings.length, 0);
  assert.equal(result.unknownCount, 0, 'a malformed row is unreadable, not an unrecognized filing-format signal');
});

// ─── Paper filing → placeholder row ────────────────────────────────────────────

test('buildPaperPlaceholder produces a scanned_unparsed row with politician/filing_date/source_id/pdf_url populated', () => {
  const meta = rowToFilingMeta(paperRow());
  const raw = buildPaperPlaceholder(meta);

  assert.equal(raw.parse_status, 'scanned_unparsed');
  assert.equal(raw.politician, 'Jane Doe');
  assert.equal(raw.filing_date, '09/17/2026');
  assert.equal(raw.source_id, '998877|paper');
  assert.equal(raw.pdf_url, 'https://efdsearch.senate.gov/search/view/paper/998877/');
  // Every transaction-detail field blank at the RawTransaction stage
  assert.equal(raw.transaction_date, '');
  assert.equal(raw.asset_name, '');
  assert.equal(raw.ticker, '');
});

// ─── Detail-page fetch failure → placeholder row, not a silent drop ───────────

test('buildFetchFailedPlaceholder produces a fetch_failed row with the error message preserved', () => {
  const meta = rowToFilingMeta(ptrRow());
  const raw = buildFetchFailedPlaceholder(meta, 'Timeout after 20000ms');

  assert.equal(raw.parse_status, 'fetch_failed');
  assert.equal(raw.politician, 'Jane Doe');
  assert.equal(raw.filing_id, 'abc12345-e1b2-411d-b562-8fe4c2a4f2a1');
  assert.equal(raw.source_id, 'abc12345-e1b2-411d-b562-8fe4c2a4f2a1|fetch_failed');
  assert.equal(raw.pdf_url, 'https://efdsearch.senate.gov/search/view/ptr/abc12345-e1b2-411d-b562-8fe4c2a4f2a1/');
  assert.equal(raw.raw_json.fetch_error, 'Timeout after 20000ms');
  // Every transaction-detail field blank, same shape as the other placeholders
  assert.equal(raw.transaction_date, '');
  assert.equal(raw.asset_name, '');
  assert.equal(raw.ticker, '');
});

test('normalize() turns a paper placeholder into a Transaction with all detail fields null', () => {
  const meta = rowToFilingMeta(paperRow());
  const raw = buildPaperPlaceholder(meta);
  const result = normalize(raw);

  assert.ok(result);
  assert.equal(result.parse_status, 'scanned_unparsed');
  assert.equal(result.politician, 'Jane Doe');
  assert.equal(result.filing_date, '09/17/2026');
  assert.equal(result.pdf_url, 'https://efdsearch.senate.gov/search/view/paper/998877/');
  assert.equal(result.transaction_date, null);
  assert.equal(result.asset_name, null);
  assert.equal(result.asset_type, null);
  assert.equal(result.asset_subtype, null);
  assert.equal(result.type, null);
  assert.equal(result.amount_min, null);
  assert.equal(result.amount_max, null);
  assert.equal(result.owner, null);
  assert.equal(result.ticker, null);
});

// ─── /ptr/ link with zero table rows → parse_failed placeholder, not silently dropped ──
// Previously this returned an empty records array (only isEmpty counted it) —
// a real filing enumerated in the listing that vanished from output with no
// trace. Now it emits a 'parse_failed' placeholder (mirrors House's
// housePdfParser.ts parse_failed) so the filing stays visible — see
// buildParseFailedPlaceholder. isEmpty is kept as a diagnostic counter only.

test('parsePtrTransactions on an empty-table /ptr/ page emits a parse_failed placeholder, not a silent drop', () => {
  const meta = rowToFilingMeta(ptrRow());
  const result = parsePtrTransactions(EMPTY_HTML, meta);

  assert.equal(result.isEmpty, true);
  assert.equal(result.records.length, 1, 'the empty page must still produce exactly one placeholder row');

  const placeholder = result.records[0];
  assert.equal(placeholder.parse_status, 'parse_failed');
  assert.equal(placeholder.politician, 'Jane Doe');
  assert.equal(placeholder.filing_id, 'abc12345-e1b2-411d-b562-8fe4c2a4f2a1');
  assert.equal(placeholder.source_id, 'abc12345-e1b2-411d-b562-8fe4c2a4f2a1|parse_failed');
  assert.equal(placeholder.pdf_url, 'https://efdsearch.senate.gov/search/view/ptr/abc12345-e1b2-411d-b562-8fe4c2a4f2a1/');
  // Every transaction-detail field blank, same shape as the paper placeholder
  assert.equal(placeholder.transaction_date, '');
  assert.equal(placeholder.asset_name, '');
  assert.equal(placeholder.ticker, '');
});

// ─── Normal /ptr/ page with real rows → existing behavior preserved ──────────

test('parsePtrTransactions on a normal PTR table still extracts rows correctly', () => {
  const meta = rowToFilingMeta(ptrRow());
  const result = parsePtrTransactions(NORMAL_TABLE_HTML, meta);

  assert.equal(result.isEmpty, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].politician, 'Jane Doe');
  assert.equal(result.records[0].ticker, 'EA');
  assert.equal(result.records[0].asset_name, 'Electronic Arts Inc.');
  assert.equal(result.records[0].parse_status, 'ok');
  assert.equal(result.records[0].pdf_url, null);
  assert.equal(result.records[0].source_id, 'abc12345-e1b2-411d-b562-8fe4c2a4f2a1|0');
});
