const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, normalizeAll } = require('../dist/transformer/normalize.js');
const { normalizeNameCase } = require('../dist/utils/names.js');
const { buildPaperPlaceholder } = require('../dist/fetcher/senateFetcher.js');

// Rows below are real, captured from run vyb2mlSRWe0HiZSeT / the live Senate
// EFD pages (ticker cell and asset_name exactly as the source printed them).

function row(overrides = {}) {
  return {
    politician: 'Thomas H Tuberville',
    transaction_date: '05/03/2024',
    filing_date: '08/05/2026',
    ticker: '--',
    asset_name: 'ROLLS-ROYCE HOLDINGS PLC ADR',
    asset_type: 'Stock',
    type: 'Sale (Full)',
    amount: '$1,001 - $15,000',
    owner: 'Joint',
    source_id: 'doc|0',
    filing_id: 'doc',
    filing_type: 'amendment',
    amendment_number: 1,
    parse_status: 'ok',
    pdf_url: null,
    raw_json: {},
    ...overrides,
  };
}

// ─── Tickers ──────────────────────────────────────────────────────────────────

test('"ROLLS" was never the source ticker — the source cell is "--"; the leading-"XXXX - " name extractor mistook the hyphen in ROLLS-ROYCE for a delimiter', () => {
  const t = normalize(row());
  assert.equal(t.ticker, null);
  assert.equal(t.asset_name, 'ROLLS-ROYCE HOLDINGS PLC ADR', 'asset_name kept');
});

test('a hyphen glued to the word is not a delimiter, but "EA - Electronic Arts" still extracts', () => {
  assert.equal(normalize(row({ asset_name: 'COCA-COLA CO' })).ticker, null);
  assert.equal(normalize(row({ asset_name: 'EA - Electronic Arts Inc' })).ticker, 'EA');
  assert.equal(normalize(row({ asset_name: 'BERY - Berry Global Group, Inc. (Exchanged)' })).ticker, 'BERY');
});

// (The real "-- AMCR" row is an EXCHANGE, where AMCR is the received asset — see
// the exchange tests at the bottom of this file. For an ordinary buy/sell the
// "--" artifact is simply stripped.)
test('"-- AMCR" on a non-exchange row: the "--" artifact is stripped, leaving AMCR', () => {
  const t = normalize(row({ ticker: '-- AMCR', asset_name: 'Amcor plc Ordinary Shares', type: 'Purchase' }));
  assert.equal(t.ticker, 'AMCR');
});

test('"COLPAL" (company-name abbreviation, 6 letters) -> ticker null, asset_name kept, no ticker invented', () => {
  const t = normalize(row({ ticker: 'COLPAL', asset_name: 'COLGATE PALMOLIVE LTD.' }));
  assert.equal(t.ticker, null);
  assert.equal(t.asset_name, 'COLGATE PALMOLIVE LTD.');
});

test('legitimate tickers are untouched: 5-letter fund/ADR/class tickers, dotted classes, dashes', () => {
  for (const ticker of ['WWSYX', 'SDZNY', 'GOOGL', 'BRK.B', 'BRK-B', 'EA', 'aapl']) {
    assert.equal(normalize(row({ ticker, asset_name: 'Some Company' })).ticker, ticker.toUpperCase(), ticker);
  }
});

test('blank / "--" / N/A ticker cells -> null (source omitted it; nothing guessed)', () => {
  for (const ticker of ['', '--', ' -- ', 'N/A', 'NA', '*']) {
    assert.equal(normalize(row({ ticker, asset_name: 'Qualcomm Inc' })).ticker, null, JSON.stringify(ticker));
  }
});

test('a ticker cell with several tickers is ambiguous -> null', () => {
  assert.equal(normalize(row({ ticker: 'AAPL MSFT', asset_name: 'Some Company' })).ticker, null);
});

// ─── Null-ticker rows that are genuinely not parse misses ─────────────────────

test('non-tradable assets keep ticker null: muni bonds, private LLCs, structured notes, source-omitted tickers', () => {
  const names = [
    ['Municipal Security', 'PENNSYLVANIA ST GO Rate/Coupon: 5% Matures: 2035-04-01'],
    ['Other', 'Not Fade Away LLC Company: Not Fade Away LLC (New York, NY) Description: Hedge Fund'],
    ['Stock', 'GS Managed Structured Note Strategy S&P 500 Linked Note'],
    ['Stock', 'Qualcomm Inc'], // source cell is literally "--"
    ['Stock', 'Nestle ADR'],
  ];
  for (const [asset_type, asset_name] of names) {
    assert.equal(normalize(row({ asset_type, asset_name })).ticker, null, asset_name);
  }
});

// ─── Names ────────────────────────────────────────────────────────────────────

test('ALL-CAPS names are re-cased; mixed-case names are untouched', () => {
  assert.equal(normalizeNameCase('RICHARD BLUMENTHAL'), 'Richard Blumenthal');
  assert.equal(normalizeNameCase('DAVID H MCCORMICK'), 'David H McCormick');
  assert.equal(normalizeNameCase('A. MITCHELL MCCONNELL, JR.'), 'A. Mitchell McConnell, Jr.');
  assert.equal(normalizeNameCase('JAMES CONLEY JUSTICE, II'), 'James Conley Justice, II');
  assert.equal(normalizeNameCase("MARY O'BRIEN-SMITH"), "Mary O'Brien-Smith");
  assert.equal(normalizeNameCase('Thomas H Tuberville'), 'Thomas H Tuberville');
  assert.equal(normalizeNameCase('Angus S King, Jr.'), 'Angus S King, Jr.');
  assert.equal(normalizeNameCase('  RICK   SCOTT '), 'Rick Scott');
});

test('normalize() on a parsed row: politician cased, politician_raw preserved verbatim', () => {
  const t = normalize(row({ politician: 'RICHARD BLUMENTHAL' }));
  assert.equal(t.politician, 'Richard Blumenthal');
  assert.equal(t.politician_raw, 'RICHARD BLUMENTHAL');
  const u = normalize(row({ politician: 'Thomas H Tuberville' }));
  assert.equal(u.politician, 'Thomas H Tuberville');
  assert.equal(u.politician_raw, 'Thomas H Tuberville');
});

// ─── scanned_unparsed placeholder (real: Blumenthal paper filings) ────────────

const PAPER_META = {
  politician: 'RICHARD BLUMENTHAL',
  filing_date: '08/31/2026',
  report_path: '/search/view/paper/929216d5-5dbd-429c-858c-1e9332924627/',
  doc_id: '929216d5-5dbd-429c-858c-1e9332924627',
  docType: 'paper',
  office: 'Senator',
};

test('scanned_unparsed placeholder: filing_date is ISO and the name matches parsed rows', () => {
  const t = normalize(buildPaperPlaceholder(PAPER_META));
  assert.equal(t.parse_status, 'scanned_unparsed');
  assert.equal(t.filing_date, '2026-08-31');
  assert.equal(t.politician, 'Richard Blumenthal');
  assert.equal(t.politician_raw, 'RICHARD BLUMENTHAL');
  assert.equal(t.transaction_date, null);
  assert.equal(t.supersedes_filing_id, null);
  assert.equal(t.is_superseded, false);
});

test('placeholder id inputs are unchanged by the casing fix (politician is lowercased in the dedup key)', () => {
  const { dedupKey } = require('../dist/utils/dedup.js');
  const before = { ...normalize(buildPaperPlaceholder(PAPER_META)), politician: 'RICHARD BLUMENTHAL' };
  const after = normalize(buildPaperPlaceholder(PAPER_META));
  assert.equal(dedupKey(before), dedupKey(after));
});

test('normalizeAll keeps placeholders alongside parsed rows, all with ISO filing_date', () => {
  const out = normalizeAll([row(), buildPaperPlaceholder(PAPER_META)]);
  assert.equal(out.length, 2);
  assert.ok(out.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.filing_date)));
});

// ─── Exchange rows: given vs received asset ───────────────────────────────────
// Real row: Wyden PTR 5ecc9b5c-07c1-4ec1-bd4a-2db759eff299 (run vyb2mlSRWe0HiZSeT).
// The ticker cell is "-- AMCR" and asset_name leads with the GIVEN asset (BERY);
// AMCR is the RECEIVED asset. The old output (ticker AMCR next to asset_name
// "BERY - …") was misleading and broke ticker filters.

const wyden = require('./fixtures/wydenExchange.json');

test('Wyden exchange: ticker is the GIVEN asset (BERY); AMCR goes to received_ticker', () => {
  const t = normalize(wyden.raw);
  assert.equal(t.type, 'exchange');
  assert.equal(t.ticker, 'BERY');
  assert.equal(t.received_ticker, 'AMCR');
  assert.equal(t.received_asset_name, 'Amcor plc Ordinary Shares');
  assert.equal(t.asset_name, wyden.raw.asset_name, 'asset_name stays as the source printed it');
});

test('Wyden exchange: a tickers=[BERY] filter keeps it, tickers=[AMCR] does not (ticker filters follow the given asset)', () => {
  const { filterRows } = require('../dist/scheduler/pipeline.js');
  const t = normalize(wyden.raw);
  assert.equal(filterRows([t], { tickers: ['BERY'] }).kept.length, 1);
  assert.equal(filterRows([t], { tickers: ['AMCR'] }).kept.length, 0);
});

test('Wyden exchange: id and content_hash are exactly what the previous version emitted', () => {
  const { generateId, computeContentHash } = require('../dist/utils/dedup.js');
  const t = normalize(wyden.raw);
  assert.equal(computeContentHash(t), wyden.emittedByTheOldCode.content_hash);
  assert.equal(generateId(t), wyden.emittedByTheOldCode.id);
});

test('Armstrong exchange (AVB -> VMRK, cell is just "--"): both tickers come from the asset_name text', () => {
  const t = normalize(row({
    ticker: '--', type: 'Exchange', politician: 'Alan Armstrong',
    asset_name: 'AvalonBay Communities, Inc. Common Stock (AVB) (Exchanged) VMRK - Vivmark Residential Common Shares of Beneficial Interest (Received)',
  }));
  assert.equal(t.ticker, 'AVB');
  assert.equal(t.received_ticker, 'VMRK');
  assert.equal(t.received_asset_name, 'Vivmark Residential Common Shares of Beneficial Interest');
});

test('exchange with a two-ticker cell and no ticker text in the name: cell is "given received"', () => {
  const t = normalize(row({ ticker: 'AAA BBB', type: 'Exchange', asset_name: 'Alpha Corp (Exchanged) Beta Corp (Received)' }));
  assert.deepEqual([t.ticker, t.received_ticker, t.received_asset_name], ['AAA', 'BBB', 'Beta Corp']);
});

test('exchange with a lone cell ticker that the text places on the received side -> received_ticker, ticker null', () => {
  const t = normalize(row({ ticker: 'BBB', type: 'Exchange', asset_name: 'Alpha Corp (Exchanged) Beta Corp (BBB) (Received)' }));
  assert.deepEqual([t.ticker, t.received_ticker], [null, 'BBB']);
});

test('exchange without the "(Exchanged)" marker: nothing is invented — received fields null, ticker as before', () => {
  const t = normalize(row({ ticker: 'XYZ', type: 'Exchange', asset_name: 'Some Merger Consideration' }));
  assert.deepEqual([t.ticker, t.received_ticker, t.received_asset_name], ['XYZ', null, null]);
});

test('buy/sell rows never get received_* values', () => {
  const t = normalize(row({ ticker: '-- AMCR', type: 'Purchase', asset_name: 'Amcor plc' }));
  assert.equal(t.received_ticker, null);
  assert.equal(t.received_asset_name, null);
  assert.equal(t.ticker, 'AMCR', 'non-exchange behavior unchanged');
});

// ─── row_index_in_filing ──────────────────────────────────────────────────────

test('placeholders carry row_index_in_filing 0; a row without one normalizes to null', () => {
  assert.equal(normalize(buildPaperPlaceholder(PAPER_META)).row_index_in_filing, 0);
  assert.equal(normalize(row({ ticker: 'AAPL' })).row_index_in_filing, null);
  assert.equal(normalize(row({ ticker: 'AAPL', row_index_in_filing: 7 })).row_index_in_filing, 7);
});

test('row_index_in_filing is NOT part of id or content_hash (identical rows keep identical hashes, ids still differ by source_id)', () => {
  const { generateId, computeContentHash } = require('../dist/utils/dedup.js');
  const a = normalize(row({ ticker: 'AAPL', row_index_in_filing: 0, source_id: 'd|0' }));
  const b = normalize(row({ ticker: 'AAPL', row_index_in_filing: 5, source_id: 'd|5' }));
  assert.equal(computeContentHash(a), computeContentHash(b));
  const withoutIdx = { ...a, row_index_in_filing: null };
  assert.equal(generateId(a), generateId(withoutIdx));
  assert.equal(computeContentHash(a), computeContentHash(withoutIdx));
  assert.notEqual(generateId(a), generateId(b));
});
