const { test } = require('node:test');
const assert = require('node:assert/strict');
const roster = require('./fixtures/legislatorsSample.json');
const { buildRoster, NameResolver, buildMemberMatcher } = require('../dist/utils/legislators.js');
const { filterFilingsEarly, sortNewestFirst, indexYears } = require('../dist/fetcher/houseFetcher.js');
const { filterRows } = require('../dist/scheduler/pipeline.js');
const { parseInput } = require('../dist/utils/input.js');
const { resolveWindow } = require('../dist/utils/window.js');
const { normalize } = require('../dist/transformer/normalize.js');

const resolver = new NameResolver(buildRoster(roster));

// ─── Roster / name resolution ─────────────────────────────────────────────────

test('buildRoster keeps House members only by default (not senators)', () => {
  assert.equal(buildRoster(roster).length, 9);
  assert.equal(buildRoster(roster, ['sen']).length, 1);
});

test('resolver: nicknames, middle names, quoted nicknames and suffixes in the index name', () => {
  assert.equal(resolver.resolve('Scott Franklin'), 'F000472');
  assert.equal(resolver.resolve('Charles J. "Chuck" Fleischmann'), 'F000459');
  assert.equal(resolver.resolve('Chuck Fleischmann'), 'F000459');
  assert.equal(resolver.resolve('Donald Sternoff Beyer Jr'), 'B001292');
  assert.equal(resolver.resolve('Don Beyer'), 'B001292');
  assert.equal(resolver.resolve('April McClain Delaney'), 'M001232');
});

test('resolver: a name shared by two members (Mike/Michael Johnson) is ambiguous -> null, never a guess', () => {
  assert.equal(resolver.resolve('Mike Johnson'), null);
});

test('resolver: a sitting senator is not in the House roster', () => {
  assert.equal(resolver.resolve('Tommy Tuberville'), null);
});

// ─── members filter ───────────────────────────────────────────────────────────

test('members: nickname vs formal name, case-insensitively', () => {
  const match = buildMemberMatcher(['chuck fleischmann'], resolver);
  assert.equal(match('Charles J. "Chuck" Fleischmann'), true);
  assert.equal(match('CHARLES J FLEISCHMANN'), true);
  assert.equal(match('Nancy Pelosi'), false);
});

test('members: "Don Beyer" matches the index\'s "Donald Sternoff Beyer Jr"', () => {
  assert.equal(buildMemberMatcher(['Don Beyer'], resolver)('Donald Sternoff Beyer Jr'), true);
});

test('members: matching still works with no roster', () => {
  const match = buildMemberMatcher(['Don Beyer'], null);
  assert.equal(match('Donald Sternoff Beyer Jr'), true);
  assert.equal(match('Nancy Pelosi'), false);
});

test('members: the source\'s doubled token ("Scott Scott Franklin") does not break matching', () => {
  const match = buildMemberMatcher(['Scott Franklin'], resolver);
  assert.equal(match('Scott Scott Franklin'), true);
});

test('members: bioguide id and bare last name work; entries are OR-ed', () => {
  assert.equal(buildMemberMatcher(['P000197'], resolver)('Nancy Pelosi'), true);
  assert.equal(buildMemberMatcher(['Pelosi', 'Hern'], resolver)('Kevin Hern'), true);
  assert.equal(buildMemberMatcher(['Pelosi'], resolver)('Kevin Hern'), false);
});

// ─── Index-level filtering (before any PDF is downloaded) ─────────────────────

function filing(member, filingDate, docId) {
  return { member, filingDate, filingDateRaw: '', docId, year: 2026 };
}

const INDEX = [
  filing('Byron Donalds', '2026-08-12', '20035420'),
  filing('Nancy Pelosi', '2026-09-20', '20035500'),
  filing('Nancy Pelosi', '2026-07-10', '20035001'),
  filing('Kevin Hern', '2026-09-25', '20035489'),
  filing('Charles J. "Chuck" Fleischmann', '2026-08-12', '20035300'),
];

test('filterFilingsEarly: members drops every non-matching filing before download', () => {
  const r = filterFilingsEarly(INDEX, { memberMatcher: buildMemberMatcher(['Nancy Pelosi', 'Chuck Fleischmann'], resolver) });
  assert.deepEqual(r.kept.map((f) => f.docId).sort(), ['20035001', '20035300', '20035500']);
  assert.equal(r.skippedByMember, 2);
});

test('filterFilingsEarly: a filing filed before transactionDateFrom cannot contain a trade on/after it', () => {
  const r = filterFilingsEarly(INDEX, { transactionDateFrom: '2026-08-12' });
  assert.equal(r.kept.length, 4);
  assert.equal(r.skippedByTransactionDate, 1);
  assert.ok(!r.kept.some((f) => f.docId === '20035001'));
});

test('filterFilingsEarly: no options keeps everything', () => {
  assert.equal(filterFilingsEarly(INDEX, {}).kept.length, 5);
});

// ─── Processing order (bug C: alphabetical index lost everyone after "H") ─────

test('sortNewestFirst: newest filing first, ties broken by higher DocID — not alphabetical', () => {
  const sorted = sortNewestFirst(INDEX);
  assert.deepEqual(sorted.map((f) => f.docId), ['20035489', '20035500', '20035420', '20035300', '20035001']);
  // The input array is not mutated.
  assert.equal(INDEX[0].member, 'Byron Donalds');
});

test('sortNewestFirst: a late-alphabet member (Pelosi) comes before an early one (Allen) when filed later', () => {
  const sorted = sortNewestFirst([filing('Richard W. Allen', '2026-07-06', '1'), filing('Nancy Pelosi', '2026-09-20', '2')]);
  assert.equal(sorted[0].member, 'Nancy Pelosi');
});

// ─── Index years ──────────────────────────────────────────────────────────────

test('indexYears: a window crossing New Year needs both ZIPs; never beyond the current year', () => {
  assert.deepEqual(indexYears('2025-12-20', '2026-01-10', 2026), [2025, 2026]);
  assert.deepEqual(indexYears('2026-07-01', '2026-10-01', 2026), [2026]);
  assert.deepEqual(indexYears('2026-07-01', '2027-01-05', 2026), [2026]);
});

// ─── Row filters ──────────────────────────────────────────────────────────────

function row(overrides = {}) {
  return {
    politician: 'Test Member', transaction_date: '2026-08-10', filing_date: '2026-08-20', ticker: 'AAPL',
    asset_name: 'Apple Inc', asset_type: 'Stock', asset_subtype: null, type: 'buy', amount_min: 1001, amount_max: 15000,
    owner: 'self', source_id: 'house_f_0', filing_id: 'f', content_hash: '', filing_type: 'original', amendment_number: null,
    parse_status: 'ok', pdf_url: null, ocr_confidence: null, fetchedAt: '', lastModifiedAt: '', revisionCount: 0, ...overrides,
  };
}

test('filterRows: no filters set returns the same rows untouched', () => {
  const rows = [row(), row({ parse_status: 'scanned_unparsed', transaction_date: null, ticker: null })];
  assert.equal(filterRows(rows, { tickers: [] }).kept.length, 2);
});

test('filterRows: tickers case-insensitive; null-ticker rows dropped', () => {
  const rows = [row(), row({ ticker: 'MSFT' }), row({ ticker: null }), row({ ticker: 'BRK.B' })];
  const r = filterRows(rows, { tickers: ['aapl', '$brk-b'] });
  assert.deepEqual(r.kept.map((t) => t.ticker), ['AAPL', 'BRK.B']);
});

test('filterRows: transaction date bounds are inclusive', () => {
  const rows = ['2026-08-09', '2026-08-10', '2026-08-20', '2026-08-21'].map((d) => row({ transaction_date: d }));
  const r = filterRows(rows, { tickers: [], transactionDateFrom: '2026-08-10', transactionDateTo: '2026-08-20' });
  assert.deepEqual(r.kept.map((t) => t.transaction_date), ['2026-08-10', '2026-08-20']);
});

test('filterRows: OCR rows are real rows (filtered like ok); placeholders are withheld under a ticker/date filter', () => {
  const ocr = row({ parse_status: 'ocr', ticker: 'AAPL' });
  const ph = row({ parse_status: 'scanned_unparsed', transaction_date: null, ticker: null });
  const r = filterRows([ocr, ph], { tickers: ['AAPL'] });
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].parse_status, 'ocr');
  assert.equal(r.placeholdersExcluded, 1);
});

// ─── Input + window (bug B) ───────────────────────────────────────────────────

test('parseInput: empty input is today\'s behavior; new fields default off', () => {
  const p = parseInput({});
  assert.deepEqual([p.members, p.tickers, p.includeDuplicates, p.enableOcr, p.debugPdfText], [[], [], false, false, false]);
});

test('parseInput: validates dates and lists', () => {
  assert.throws(() => parseInput({ transactionDateFrom: '08/10/2026' }), /YYYY-MM-DD/);
  assert.throws(() => parseInput({ transactionDateTo: '2026-02-30' }), /real calendar date/);
  assert.throws(() => parseInput({ transactionDateFrom: '2026-09-01', transactionDateTo: '2026-08-01' }), /after/);
  assert.throws(() => parseInput({ members: 'Nancy Pelosi' }), /array of strings/);
  assert.deepEqual(parseInput({ tickers: ['aapl', '$BRK-B'] }).tickers, ['AAPL', 'BRK.B']);
});

// Reproduced from a real run: fetchDaysBack=30 on 2026-10-01 returned filings
// dated 2026-07-06..2026-09-25 (a 90-day window). apify.ts set
// process.env.FETCH_DAYS_BACK after config.ts had read the environment at
// import time. The window is a FILING-date window, so transaction dates
// (2025-12-16..2026-09-15 in that run) legitimately reach back further.
test('resolveWindow: fetchDaysBack=30 starts 30 days back, not at the 90-day default', () => {
  const today = new Date(2026, 9, 1);
  assert.deepEqual(resolveWindow({ fetchDaysBack: 30 }, 90, today), { fromDate: '2026-09-01', toDate: '2026-10-01' });
  assert.deepEqual(resolveWindow({}, 90, today), { fromDate: '2026-07-03', toDate: '2026-10-01' });
  assert.deepEqual(resolveWindow({ fromDate: '2026-09-28', toDate: '2026-09-28', fetchDaysBack: 30 }, 90, today), { fromDate: '2026-09-28', toDate: '2026-09-28' });
});

test('config.ts reads FETCH_DAYS_BACK at import time — why env-after-import could never work', () => {
  const { config } = require('../dist/utils/config.js');
  process.env.FETCH_DAYS_BACK = '7';
  assert.notEqual(config.FETCH_DAYS_BACK, 7);
  delete process.env.FETCH_DAYS_BACK;
});

// ─── bioguide / politician_raw ────────────────────────────────────────────────

test('normalize keeps politician_raw while collapsing the source\'s doubled name token', () => {
  const t = normalize({
    politician: 'Scott Scott Franklin', transaction_date: '08/26/2026', filing_date: '2026-09-17', ticker: 'ACN',
    asset_name: 'Accenture plc', asset_type: 'Stock', type: 'Purchase', amount: '$1,001 - $15,000', owner: 'self',
    source_id: 'house_20035450_0', filing_id: '20035450', filing_type: 'original', parse_status: 'ok', pdf_url: 'x',
    ocr_confidence: null, raw_json: {},
  });
  assert.equal(t.politician, 'Scott Franklin');
  assert.equal(t.politician_raw, 'Scott Scott Franklin');
  assert.equal(resolver.resolve(t.politician), 'F000472');
});
