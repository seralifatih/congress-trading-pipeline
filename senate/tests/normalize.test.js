const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, normalizeAll } = require('../dist/transformer/normalize.js');

// Real row captured from Senate EFD PTR b999bc0e-3eb0-4ca9-ab07-8e8f2e04b41f
// (Alan Armstrong, AvalonBay -> Vivmark asset exchange). Before the fix,
// raw type "Exchange" had no TYPE_MAP entry, normalizeType() returned null,
// and the row was silently dropped (reason=unrecognized_type).
function exchangeRow(overrides = {}) {
  return {
    politician: 'Alan Armstrong',
    transaction_date: '08/14/2026',
    filing_date: '09/17/2026',
    ticker: '--',
    asset_name:
      'AvalonBay Communities, Inc. Common Stock (AVB) (Exchanged) VMRK - Vivmark Residential Common Shares of Beneficial Interest (Received)',
    asset_type: 'Stock',
    type: 'Exchange',
    amount: '$1,001 - $15,000',
    owner: 'Joint',
    source_id: 'b999bc0e-3eb0-4ca9-ab07-8e8f2e04b41f|2',
    filing_type: 'original',
    amendment_number: null,
    raw_json: {},
    ...overrides,
  };
}

test('Senate "Exchange" rows normalize to type "exchange", not dropped', () => {
  const result = normalize(exchangeRow());
  assert.notEqual(result, null, 'exchange row must not be skipped as unrecognized_type');
  assert.equal(result.type, 'exchange');
  assert.equal(result.politician, 'Alan Armstrong');
  assert.equal(result.amount_min, 1001);
  assert.equal(result.amount_max, 15000);
  assert.equal(result.owner, 'joint');
  assert.equal(result.parse_status, 'ok');
  assert.equal(result.pdf_url, null);
});

test('normalizeAll keeps an exchange row alongside buy/sell rows', () => {
  const buyRow = exchangeRow({
    type: 'Purchase',
    source_id: 'b999bc0e-3eb0-4ca9-ab07-8e8f2e04b41f|0',
  });
  const results = normalizeAll([buyRow, exchangeRow()]);
  assert.equal(results.length, 2, 'exchange row must survive normalizeAll, not be skipped');
  assert.deepEqual(
    results.map((r) => r.type).sort(),
    ['buy', 'exchange'],
  );
});

test('an actually-unrecognized type is still skipped (regression guard)', () => {
  const result = normalize(exchangeRow({ type: 'Something Else Entirely' }));
  assert.equal(result, null);
});
