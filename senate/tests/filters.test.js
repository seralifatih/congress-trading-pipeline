const { test } = require('node:test');
const assert = require('node:assert/strict');
const roster = require('./fixtures/legislatorsSample.json');
const { buildRoster, NameResolver, buildMemberMatcher } = require('../dist/utils/legislators.js');
const { filterFilingsEarly } = require('../dist/fetcher/senateFetcher.js');
const { filterRows } = require('../dist/scheduler/pipeline.js');
const { parseInput } = require('../dist/utils/input.js');
const { resolveWindow } = require('../dist/utils/window.js');
const { normalize } = require('../dist/transformer/normalize.js');

const resolver = new NameResolver(buildRoster(roster));

// ─── Roster / name resolution ─────────────────────────────────────────────────

test('buildRoster keeps senators only by default', () => {
  assert.equal(buildRoster(roster).length, 9);
  assert.equal(buildRoster(roster, ['sen', 'rep']).length, 10);
});

test('resolver: formal listing name resolves to the nickname roster entry (Thomas H Tuberville -> Tommy)', () => {
  assert.equal(resolver.resolve('Thomas H Tuberville'), 'T000278');
  assert.equal(resolver.resolve('Tommy Tuberville'), 'T000278');
});

test('resolver: middle names, initials and suffixes in the listing name', () => {
  assert.equal(resolver.resolve('A. Mitchell McConnell, Jr.'), 'M000355');
  assert.equal(resolver.resolve('David H McCormick'), 'M001243');
  assert.equal(resolver.resolve('Angus S King, Jr.'), 'K000383');
  assert.equal(resolver.resolve('Timothy P Sheehy'), 'S001232');
  assert.equal(resolver.resolve('Catherine Cortez Masto'), 'C001113');
});

test('resolver: ALL-CAPS paper-filing name resolves', () => {
  assert.equal(resolver.resolve('RICHARD BLUMENTHAL'), 'B001277');
});

test('resolver: initial + last name resolves only when unique ("R. Scott" -> Rick, "Scott" alone does not)', () => {
  assert.equal(resolver.resolve('R. Scott'), 'S001217');
  assert.equal(resolver.resolve('Scott'), null);
  assert.equal(resolver.resolve('S. Scott'), null, 'no senator Scott with initial S');
});

test('resolver: unknown filer resolves to null, never a guess', () => {
  assert.equal(resolver.resolve('Alan Armstrong'), null);
});

// ─── members filter ───────────────────────────────────────────────────────────

test('members: "Tommy Tuberville" matches "Thomas H Tuberville" (nickname vs formal), case-insensitively', () => {
  const match = buildMemberMatcher(['tommy tuberville'], resolver);
  assert.equal(match('Thomas H Tuberville'), true);
  assert.equal(match('THOMAS H TUBERVILLE'), true);
  assert.equal(match('Richard Blumenthal'), false);
});

test('members: token matching still works with no roster (roster download failed)', () => {
  const match = buildMemberMatcher(['Tommy Tuberville'], null);
  assert.equal(match('Thomas H Tuberville'), true);
  assert.equal(match('Tim Scott'), false);
});

test('members: a bioguide id works', () => {
  const match = buildMemberMatcher(['T000278'], resolver);
  assert.equal(match('Thomas H Tuberville'), true);
  assert.equal(match('Rick Scott'), false);
});

test('members: two senators sharing a last name are distinguished by first name', () => {
  const match = buildMemberMatcher(['Rick Scott'], resolver);
  assert.equal(match('Rick Scott'), true);
  assert.equal(match('Tim Scott'), false);
});

test('members: a bare last name matches every filer with it', () => {
  const match = buildMemberMatcher(['Scott'], resolver);
  assert.equal(match('Rick Scott'), true);
  assert.equal(match('Tim Scott'), true);
  assert.equal(match('Mark R Warner'), false);
});

test('members: several entries are OR-ed', () => {
  const match = buildMemberMatcher(['Tommy Tuberville', 'Dave McCormick'], resolver);
  assert.equal(match('David H McCormick'), true);
  assert.equal(match('Thomas H Tuberville'), true);
  assert.equal(match('Richard Blumenthal'), false);
});

// ─── Early (pre-detail-fetch) filtering ───────────────────────────────────────

function filing(politician, filing_date, doc_id) {
  return { politician, filing_date, report_path: `/search/view/ptr/${doc_id}/`, doc_id, docType: 'ptr', office: '' };
}

test('filterFilingsEarly drops non-matching members before any detail fetch', () => {
  const filings = [
    filing('Thomas H Tuberville', '08/05/2026', 'a'),
    filing('Richard Blumenthal', '09/28/2026', 'b'),
    filing('RICHARD BLUMENTHAL', '08/31/2026', 'c'),
  ];
  const r = filterFilingsEarly(filings, { memberMatcher: buildMemberMatcher(['Richard Blumenthal'], resolver) });
  assert.deepEqual(r.kept.map((f) => f.doc_id), ['b', 'c']);
  assert.equal(r.skippedByMember, 1);
});

test('filterFilingsEarly: a filing filed before transactionDateFrom cannot contain a trade on/after it', () => {
  const filings = [
    filing('A', '09/28/2026', 'new'),
    filing('A', '08/31/2026', 'edge'),
    filing('A', '08/21/2026', 'old'),
  ];
  const r = filterFilingsEarly(filings, { transactionDateFrom: '2026-08-31' });
  assert.deepEqual(r.kept.map((f) => f.doc_id), ['new', 'edge']);
  assert.equal(r.skippedByTransactionDate, 1);
});

test('filterFilingsEarly: an unparseable listing date is kept, never dropped on missing evidence', () => {
  const r = filterFilingsEarly([filing('A', 'garbage', 'x')], { transactionDateFrom: '2026-08-31' });
  assert.equal(r.kept.length, 1);
});

test('filterFilingsEarly with no options keeps everything', () => {
  const filings = [filing('A', '08/05/2026', 'a'), filing('B', '08/06/2026', 'b')];
  const r = filterFilingsEarly(filings, {});
  assert.equal(r.kept.length, 2);
});

// ─── Row filters (tickers / transaction date) ─────────────────────────────────

function row(overrides = {}) {
  return {
    politician: 'Test Senator', transaction_date: '2026-08-10', filing_date: '2026-08-20', ticker: 'AAPL',
    asset_name: 'Apple Inc', asset_type: 'Stock', asset_subtype: null, type: 'buy', amount_min: 1001, amount_max: 15000,
    owner: 'self', source_id: 'f|0', filing_id: 'f', content_hash: '', filing_type: 'original', amendment_number: null,
    parse_status: 'ok', pdf_url: null, fetchedAt: '', lastModifiedAt: '', revisionCount: 0, ...overrides,
  };
}

test('filterRows: no filters set returns the same rows untouched', () => {
  const rows = [row(), row({ parse_status: 'scanned_unparsed', transaction_date: null, ticker: null })];
  const r = filterRows(rows, { tickers: [] });
  assert.equal(r.kept.length, 2);
  assert.equal(r.placeholdersExcluded, 0);
});

test('filterRows: tickers is case-insensitive, drops other tickers and null-ticker rows', () => {
  const rows = [row(), row({ ticker: 'MSFT' }), row({ ticker: null }), row({ ticker: 'BRK.B' })];
  const r = filterRows(rows, { tickers: ['aapl', '$brk-b'] });
  assert.deepEqual(r.kept.map((t) => t.ticker), ['AAPL', 'BRK.B']);
  assert.equal(r.filteredByTicker, 2);
});

test('filterRows: transaction date bounds are inclusive', () => {
  const rows = [
    row({ transaction_date: '2026-08-09' }),
    row({ transaction_date: '2026-08-10' }),
    row({ transaction_date: '2026-08-20' }),
    row({ transaction_date: '2026-08-21' }),
  ];
  const r = filterRows(rows, { tickers: [], transactionDateFrom: '2026-08-10', transactionDateTo: '2026-08-20' });
  assert.deepEqual(r.kept.map((t) => t.transaction_date), ['2026-08-10', '2026-08-20']);
  assert.equal(r.filteredByTransactionDate, 2);
});

test('filterRows: placeholders are withheld when a ticker/date filter is active (content unknown)', () => {
  const ph = row({ parse_status: 'scanned_unparsed', transaction_date: null, ticker: null });
  assert.equal(filterRows([ph], { tickers: ['AAPL'] }).placeholdersExcluded, 1);
  assert.equal(filterRows([ph], { tickers: [], transactionDateFrom: '2026-01-01' }).kept.length, 0);
  assert.equal(filterRows([ph], { tickers: [] }).kept.length, 1, 'no ticker/date filter -> placeholder kept');
});

// ─── Input parsing ────────────────────────────────────────────────────────────

test('parseInput: empty input is today\'s behavior', () => {
  const p = parseInput({});
  assert.deepEqual(p.members, []);
  assert.deepEqual(p.tickers, []);
  assert.equal(p.includeDuplicates, false);
  assert.equal(p.fetchDaysBack, undefined);
  assert.equal(parseInput(null).includeDuplicates, false);
});

test('parseInput: trims members, normalizes tickers, passes fetchDaysBack/debugPtrLimit through', () => {
  const p = parseInput({ members: [' Tommy Tuberville ', ''], tickers: ['aapl', '$BRK-B'], fetchDaysBack: 30, debugPtrLimit: 2 });
  assert.deepEqual(p.members, ['Tommy Tuberville']);
  assert.deepEqual(p.tickers, ['AAPL', 'BRK.B']);
  assert.equal(p.fetchDaysBack, 30);
  assert.equal(p.debugPtrLimit, 2);
});

test('parseInput: rejects malformed and impossible dates, inverted ranges, non-array lists', () => {
  assert.throws(() => parseInput({ transactionDateFrom: '08/10/2026' }), /YYYY-MM-DD/);
  assert.throws(() => parseInput({ transactionDateTo: '2026-02-30' }), /real calendar date/);
  assert.throws(() => parseInput({ transactionDateFrom: '2026-09-01', transactionDateTo: '2026-08-01' }), /after/);
  assert.throws(() => parseInput({ fromDate: '2026-09-01', toDate: '2026-08-01' }), /after/);
  assert.throws(() => parseInput({ members: 'Tommy Tuberville' }), /array of strings/);
});

// ─── Window (bug B) ───────────────────────────────────────────────────────────
// Reproduced with a real run: fetchDaysBack=30 on 2026-10-01 returned filings
// back to 2026-08-05. apify.ts set process.env.FETCH_DAYS_BACK AFTER config.ts
// had already read the environment at import time, so the input was ignored
// and the 90-day default (2026-07-03) applied. resolveWindow takes the value
// as an argument instead.

test('resolveWindow: fetchDaysBack=30 starts 30 days back, not at the 90-day default', () => {
  const today = new Date(2026, 9, 1); // 2026-10-01 local
  assert.deepEqual(resolveWindow({ fetchDaysBack: 30 }, 90, today), { fromDate: '2026-09-01', toDate: '2026-10-01' });
  assert.deepEqual(resolveWindow({}, 90, today), { fromDate: '2026-07-03', toDate: '2026-10-01' });
});

test('resolveWindow: explicit fromDate/toDate override fetchDaysBack', () => {
  const today = new Date(2026, 9, 1);
  assert.deepEqual(
    resolveWindow({ fromDate: '2026-09-28', toDate: '2026-09-28', fetchDaysBack: 30 }, 90, today),
    { fromDate: '2026-09-28', toDate: '2026-09-28' },
  );
});

test('config.ts reads FETCH_DAYS_BACK at import time — why env-after-import could never work', () => {
  const { config } = require('../dist/utils/config.js');
  process.env.FETCH_DAYS_BACK = '7';
  assert.notEqual(config.FETCH_DAYS_BACK, 7, 'late env assignment must not change the already-loaded config');
  delete process.env.FETCH_DAYS_BACK;
});

// ─── bioguide enrichment inputs (politician_raw kept) ─────────────────────────

test('normalize keeps politician_raw while re-casing an ALL-CAPS paper-filing name', () => {
  const t = normalize({
    politician: 'RICHARD BLUMENTHAL', transaction_date: '', filing_date: '08/31/2026', ticker: '', asset_name: '',
    asset_type: '', type: '', amount: '', owner: '', source_id: 'p|paper', filing_id: 'p', filing_type: null,
    amendment_number: null, parse_status: 'scanned_unparsed', pdf_url: 'https://efdsearch.senate.gov/search/view/paper/p/',
    raw_json: {},
  });
  assert.equal(t.politician, 'Richard Blumenthal');
  assert.equal(t.politician_raw, 'RICHARD BLUMENTHAL');
  assert.equal(t.filing_date, '2026-08-31');
  assert.equal(t.member_bioguide_id, null);
  assert.equal(resolver.resolve(t.politician_raw), 'B001277');
});
