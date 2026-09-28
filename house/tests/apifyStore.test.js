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

// ApifyStore.save() charges the 'transaction' event only for parse_status
// "ok" rows — a scanned-PDF placeholder is written to the dataset (still
// real, useful output) but never charged. Actor.charge() itself no-ops with
// a warning when the Actor isn't on pay-per-event pricing (true in this
// local-dev test run), so this test verifies the *count* passed to
// Actor.charge is correct, not the platform-side billing outcome.
test('save() charges only for parse_status "ok" rows, not scanned_unparsed placeholders', async () => {
  await Actor.init();
  try {
    const { ApifyStore } = require('../dist/store/apifyStore.js');
    const store = ApifyStore.getInstance();

    let chargedCount = null;
    const originalCharge = Actor.charge.bind(Actor);
    Actor.charge = async (opts) => {
      chargedCount = opts.count;
      return originalCharge(opts);
    };

    try {
      await store.save([transactionRow(), scannedPlaceholderRow()]);
    } finally {
      Actor.charge = originalCharge;
    }

    assert.equal(chargedCount, 1, 'should charge for exactly the 1 "ok" row, not the placeholder');
  } finally {
    await Actor.exit({ exit: false });
  }
});

test('save() does not call charge at all when every row is a placeholder', async () => {
  await Actor.init();
  try {
    const { ApifyStore } = require('../dist/store/apifyStore.js');
    const store = ApifyStore.getInstance();

    let chargeCalled = false;
    const originalCharge = Actor.charge.bind(Actor);
    Actor.charge = async (opts) => {
      chargeCalled = true;
      return originalCharge(opts);
    };

    try {
      await store.save([scannedPlaceholderRow()]);
    } finally {
      Actor.charge = originalCharge;
    }

    assert.equal(chargeCalled, false, 'charge() should never be called when there are zero billable rows');
  } finally {
    await Actor.exit({ exit: false });
  }
});

test('save() does not charge for a parse_failed placeholder either — same free rule as scanned_unparsed', async () => {
  await Actor.init();
  try {
    const { ApifyStore } = require('../dist/store/apifyStore.js');
    const store = ApifyStore.getInstance();

    let chargedCount = null;
    const originalCharge = Actor.charge.bind(Actor);
    Actor.charge = async (opts) => {
      chargedCount = opts.count;
      return originalCharge(opts);
    };

    try {
      await store.save([transactionRow(), parseFailedPlaceholderRow()]);
    } finally {
      Actor.charge = originalCharge;
    }

    assert.equal(chargedCount, 1, 'should charge for exactly the 1 "ok" row, not the parse_failed placeholder');
  } finally {
    await Actor.exit({ exit: false });
  }
});
