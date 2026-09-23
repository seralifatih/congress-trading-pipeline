const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'house-api-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { createApp } = require('../dist/api/server.js');
const { SqliteStore } = require('../dist/store/sqliteStore.js');

function row(overrides) {
  return {
    politician: 'Test Member',
    transaction_date: '2026-08-01',
    filing_date: '2026-08-10',
    ticker: 'AAPL',
    asset_name: 'Apple Inc. - Common Stock',
    asset_type: 'Stock',
    type: 'buy',
    amount_min: 1001,
    amount_max: 15000,
    owner: 'self',
    source_id: 'house_1_0',
    content_hash: 'h1',
    filing_type: 'original',
    parse_status: 'ok',
    pdf_url: 'https://example.invalid/1.pdf',
    fetchedAt: '2026-08-10T00:00:00.000Z',
    lastModifiedAt: '2026-08-10T00:00:00.000Z',
    revisionCount: 0,
    ...overrides,
  };
}

const store = SqliteStore.getInstance();
let server;

after(() => {
  server?.close();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('/api/transactions leaves out scanned_unparsed placeholder rows', async () => {
  await store.save([
    row({ id: 'ok-row' }),
    row({
      id: 'scanned-row',
      source_id: 'house_2_scanned',
      content_hash: 'h2',
      transaction_date: null,
      ticker: null,
      asset_name: null,
      asset_type: null,
      type: null,
      amount_min: null,
      amount_max: null,
      owner: null,
      filing_type: null,
      parse_status: 'scanned_unparsed',
    }),
  ]);
  assert.equal(store.count(), 2, 'both rows are stored');

  server = createApp().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/transactions`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.data[0].id, 'ok-row');
  assert.equal(body.data[0].trade_type, 'purchase');
  assert.ok(body.data.every((s) => s.parse_status === 'ok'));
});
