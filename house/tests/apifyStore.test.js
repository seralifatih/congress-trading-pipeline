const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Actor } = require('apify');

function transactionRow(overrides = {}) {
  return {
    id: '1',
    politician: 'Test Representative',
    transaction_date: '2026-01-01',
    filing_date: '2026-01-02',
    ticker: null,
    asset_name: 'Electronic Arts Inc.',
    asset_type: 'Stock',
    asset_subtype: null,
    type: 'buy',
    amount_min: 1001,
    amount_max: 15000,
    owner: 'self',
    source_id: 'house_20035106_0',
    filing_id: '20035106',
    content_hash: 'h',
    filing_type: null,
    amendment_number: null,
    parse_status: 'ok',
    pdf_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035106.pdf',
    fetchedAt: 'x',
    lastModifiedAt: 'x',
    revisionCount: 0,
    ...overrides,
  };
}

function scannedPlaceholderRow(overrides = {}) {
  return transactionRow({
    id: '2',
    transaction_date: null,
    asset_name: null,
    asset_type: null,
    type: null,
    amount_min: null,
    amount_max: null,
    owner: null,
    ticker: null,
    source_id: 'house_9116331_scanned',
    content_hash: '',
    parse_status: 'scanned_unparsed',
    ...overrides,
  });
}

function parseFailedPlaceholderRow(overrides = {}) {
  return transactionRow({
    id: '3',
    transaction_date: null,
    asset_name: null,
    asset_type: null,
    type: null,
    amount_min: null,
    amount_max: null,
    owner: null,
    ticker: null,
    source_id: 'house_20034999_parse_failed',
    content_hash: '',
    parse_status: 'parse_failed',
    ...overrides,
  });
}

// Billing model (checked against the Actor's published pricing and apify@3.7.0
// charging.js): the only priced per-record event is the platform's
// 'apify-default-dataset-item' ("Transaction record"), billed for EVERY row
// written to the default dataset — placeholders included. ApifyStore.save()
// just writes the rows (the push is the charge) and makes no Actor.charge()
// call; the old call targeted an unregistered 'transaction' event and only
// logged a warning. Placeholders stay in the default dataset.
test('save() writes every placeholder kind to the default dataset alongside real rows and makes no Actor.charge() call', async () => {
  await Actor.init();
  try {
    const { ApifyStore } = require('../dist/store/apifyStore.js');
    const store = ApifyStore.getInstance();
    let chargeCalls = 0;
    const originalCharge = Actor.charge.bind(Actor);
    Actor.charge = async (opts) => { chargeCalls++; return originalCharge(opts); };
    let result;
    try {
      result = await store.save([transactionRow(), scannedPlaceholderRow(), parseFailedPlaceholderRow()]);
    } finally {
      Actor.charge = originalCharge;
    }
    assert.equal(chargeCalls, 0, 'the dead Actor.charge(transaction) call is gone');
    assert.deepEqual([result.saved, result.notSaved, result.truncated], [3, 0, false], 'every row, placeholders included, is written');
  } finally {
    await Actor.exit({ exit: false });
  }
});

test('save() of only placeholders still writes them (they are not moved out of the default dataset)', async () => {
  await Actor.init();
  try {
    const { ApifyStore } = require('../dist/store/apifyStore.js');
    const result = await ApifyStore.getInstance().save([scannedPlaceholderRow()]);
    assert.equal(result.saved, 1);
  } finally {
    await Actor.exit({ exit: false });
  }
});
