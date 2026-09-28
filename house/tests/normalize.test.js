const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../dist/transformer/normalize.js');

// ─── Ticker fallback extraction from asset_name ───────────────────────────────
// Mirrors senate/tests/normalize.test.js — same extraction logic is
// duplicated in both actors' normalize.ts.

function buyRow(overrides = {}) {
  return {
    politician: 'Test Representative',
    transaction_date: '08/14/2026',
    filing_date: '09/17/2026',
    ticker: '',
    asset_name: 'placeholder',
    asset_type: 'Stock',
    type: 'Purchase',
    amount: '$1,001 - $15,000',
    owner: 'Self',
    source_id: 'test-source-id',
    filing_type: 'original',
    parse_status: 'ok',
    pdf_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/test.pdf',
    ...overrides,
  };
}

function exchangeRow(overrides = {}) {
  return buyRow({
    type: 'Exchange',
    asset_name:
      'AvalonBay Communities, Inc. Common Stock (AVB) (Exchanged) VMRK - Vivmark Residential Common Shares of Beneficial Interest (Received)',
    ...overrides,
  });
}

test('extracts ticker from trailing "(XXXX)" pattern', () => {
  const result = normalize(buyRow({ asset_name: 'Electronic Arts Inc. (EA)' }));
  assert.equal(result.ticker, 'EA');
});

test('extracts ticker from leading "XXXX - Company" pattern', () => {
  const result = normalize(buyRow({ asset_name: 'EA - Electronic Arts Inc' }));
  assert.equal(result.ticker, 'EA');
});

test('exchange row: takes the first ticker (given asset), not the received one', () => {
  const result = normalize(exchangeRow());
  assert.equal(
    result.ticker,
    'AVB',
    'should extract AVB (the asset being reported), not VMRK (the received asset)',
  );
});

test('does not extract a ticker from an "(LLC)"-style entity suffix', () => {
  const result = normalize(
    buyRow({ asset_name: 'Not Fade Away LLC Private Investment Fund (New York, NY)' }),
  );
  assert.equal(result.ticker, null);
});

// State postal codes are NOT stoplisted — they collide with real tickers.
test('extracts "(MA)" as Mastercard\'s ticker, not a Massachusetts state code', () => {
  const result = normalize(buyRow({ asset_name: 'Mastercard Incorporated Common Stock (MA)' }));
  assert.equal(result.ticker, 'MA');
});

test('extracts "(MS)" as Morgan Stanley\'s ticker, not a Mississippi state code', () => {
  const result = normalize(buyRow({ asset_name: 'Morgan Stanley (MS)' }));
  assert.equal(result.ticker, 'MS');
});

test('extracts "(DE)" as Deere\'s ticker, not a Delaware state code', () => {
  const result = normalize(buyRow({ asset_name: 'Deere & Company (DE)' }));
  assert.equal(result.ticker, 'DE');
});

test('does not extract a ticker from a "(City, ST)" address suffix', () => {
  const result = normalize(buyRow({ asset_name: 'webAI, Inc. Common Stock (Austin, TX)' }));
  assert.equal(result.ticker, null);
});

test('does not extract a ticker from stoplisted qualifiers like "(THE)"', () => {
  const result = normalize(buyRow({ asset_name: 'Some Trust Fund (THE)' }));
  assert.equal(result.ticker, null);
});

test('structured ticker field still takes priority over asset_name fallback', () => {
  const result = normalize(
    buyRow({ ticker: 'MSFT', asset_name: 'Microsoft Corp (Different Corp Inc)' }),
  );
  assert.equal(result.ticker, 'MSFT');
});

// ─── asset_subtype derivation ───────────────────────────────────────────────────
// House's asset_type is already mapped from the source PDF's own marker code
// by the time normalize() sees it (ASSET_TYPE_MAP in housePdfParser.ts: ET →
// "ETF", MF → "Mutual Fund") — asset_subtype just projects that direct source
// signal, unlike Senate's asset_name text guess. See housePdfParser.test.js
// for coverage of the [ET]/[MF] marker-to-asset_type mapping itself.

test('asset_subtype "ETF" when the source marker mapped asset_type to "ETF"', () => {
  const result = normalize(
    buyRow({ asset_type: 'ETF', asset_name: 'iShares Core S&P 500 ETF', ticker: 'IVV' }),
  );
  assert.equal(result.asset_subtype, 'ETF');
});

test('asset_subtype "Mutual Fund" when the source marker mapped asset_type to "Mutual Fund"', () => {
  const result = normalize(
    buyRow({
      asset_type: 'Mutual Fund',
      asset_name: 'Westwood Quality SmallCap Fund - Institutional Ultra Shares',
    }),
  );
  assert.equal(result.asset_subtype, 'Mutual Fund');
});

test('asset_subtype is null for a plain "Stock" asset_type', () => {
  const result = normalize(
    buyRow({ asset_type: 'Stock', asset_name: 'Wells Fargo & Company Common Stock' }),
  );
  assert.equal(result.asset_subtype, null);
});

test('asset_subtype is null for "Other", even with "Fund" in the name', () => {
  const result = normalize(
    buyRow({
      asset_type: 'Other',
      asset_name: 'Not Fade Away LLC Private Investment Fund Description: Hedge Fund',
    }),
  );
  assert.equal(result.asset_subtype, null);
});

// ─── Amount parsing: single exact amount with cents ────────────────────────────

test('a single exact-dollar amount with cents keeps its cents, not truncated to a whole dollar', () => {
  // Regression guard: stripAmount() used to run parseInt() on the cleaned
  // amount string, which silently truncates "2,722.50" to 2722 (parseInt
  // stops at the first non-digit character, the decimal point).
  const result = normalize(buyRow({ amount: '$2,722.50' }));
  assert.equal(result.amount_min, 2722.5);
  assert.equal(result.amount_max, 2722.5);
});

test('a whole-dollar range still parses as plain integers (no unintended float drift)', () => {
  const result = normalize(buyRow({ amount: '$1,001 - $15,000' }));
  assert.equal(result.amount_min, 1001);
  assert.equal(result.amount_max, 15000);
});
