const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'senate-pipeline-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { SqliteStore } = require('../dist/store/sqliteStore.js');
const { placeholdersByFilingId, dedup, generateId, computeContentHash, latestBySourceId } = require('../dist/utils/dedup.js');

const store = SqliteStore.getInstance();

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Placeholder supersession ──────────────────────────────────────────────────
// Mirrors, step by step, what scheduler/pipeline.ts's supersede logic does
// (placeholdersByFilingId + deleteByFilingIds) — see house/tests/pipeline.
// test.js for the identical House-side version and why runPipeline() itself
// isn't called directly (its fetch layer isn't dependency-injectable).

function placeholderRow(overrides = {}) {
  return {
    id: 'fetch-failed-row',
    politician: 'Test Senator',
    transaction_date: null,
    filing_date: '2026-08-10',
    ticker: null,
    asset_name: null,
    asset_type: null,
    asset_subtype: null,
    type: null,
    amount_min: null,
    amount_max: null,
    owner: null,
    source_id: 'abc-5001|fetch_failed',
    filing_id: 'abc-5001',
    content_hash: '',
    filing_type: null,
    amendment_number: null,
    parse_status: 'fetch_failed',
    pdf_url: 'https://efdsearch.senate.gov/search/view/ptr/abc-5001/',
    fetchedAt: '2026-08-10T00:00:00.000Z',
    lastModifiedAt: '2026-08-10T00:00:00.000Z',
    revisionCount: 0,
    ...overrides,
  };
}

function realRow(overrides = {}) {
  return {
    id: 'real-row-0',
    politician: 'Test Senator',
    transaction_date: '2026-08-01',
    filing_date: '2026-08-10',
    ticker: 'AAPL',
    asset_name: 'Apple Inc.',
    asset_type: 'Stock',
    asset_subtype: null,
    type: 'buy',
    amount_min: 1001,
    amount_max: 15000,
    owner: 'self',
    source_id: 'abc-5001|0',
    filing_id: 'abc-5001',
    content_hash: 'realhash0',
    filing_type: null,
    amendment_number: null,
    parse_status: 'ok',
    pdf_url: null,
    fetchedAt: '2026-08-10T00:00:00.000Z',
    lastModifiedAt: '2026-08-10T00:00:00.000Z',
    revisionCount: 0,
    ...overrides,
  };
}

test('a fetch_failed placeholder is written to the store when a filing has no real rows yet', async () => {
  await store.save([placeholderRow({ id: 'ph-1', source_id: 'abc-6001|fetch_failed', filing_id: 'abc-6001' })]);

  const all = await store.query({ limit: 100 });
  const found = all.find((t) => t.filing_id === 'abc-6001');
  assert.ok(found, 'placeholder row must be queryable');
  assert.equal(found.parse_status, 'fetch_failed');
});

test('supersession: a later successful parse for the same filing_id removes the stale fetch_failed placeholder', async () => {
  // Step 1: a run that fails to fetch filing abc-5001 writes a fetch_failed placeholder.
  await store.save([placeholderRow()]);
  let existing = await store.query({ limit: 100 });
  assert.equal(existing.filter((t) => t.filing_id === 'abc-5001').length, 1, 'only the placeholder exists so far');
  assert.equal(existing.find((t) => t.filing_id === 'abc-5001').parse_status, 'fetch_failed');

  // Step 2: a later run successfully fetches and parses filing abc-5001.
  const incoming = [realRow()];
  const existingPlaceholderByFilingId = placeholdersByFilingId(existing);
  const staleFilingIds = new Set();
  for (const t of incoming) {
    if (t.parse_status === 'ok' && existingPlaceholderByFilingId.has(t.filing_id)) {
      staleFilingIds.add(t.filing_id);
    }
  }
  assert.deepEqual([...staleFilingIds], ['abc-5001'], 'the real row must be recognized as superseding filing_id abc-5001\'s placeholder');

  const netNew = dedup(incoming, existing);
  assert.equal(netNew.length, 1, 'the real row is net-new relative to the placeholder');

  const priorBySourceId = latestBySourceId(existing);
  const now = new Date().toISOString();
  const withIds = netNew.map((t) => {
    const content_hash = computeContentHash(t);
    const prior = priorBySourceId.get(t.source_id);
    return {
      ...t,
      id: t.id ?? generateId(t),
      content_hash,
      fetchedAt: prior ? (prior.fetchedAt ?? now) : now,
      lastModifiedAt: now,
      revisionCount: prior ? (prior.revisionCount ?? 0) + 1 : 0,
    };
  });
  await store.save(withIds);

  // Step 3: delete the stale placeholder — the exact call pipeline.ts makes
  // after a successful save. Must NOT also delete the just-saved real row
  // (both share filing_id "abc-5001") — see sqliteStore.ts's
  // deleteByFilingIds comment for the bug this specifically guards against.
  await store.deleteByFilingIds([...staleFilingIds]);

  const final = await store.query({ limit: 100 });
  const rowsForFiling = final.filter((t) => t.filing_id === 'abc-5001');
  assert.equal(rowsForFiling.length, 1, 'exactly one row should remain for filing_id abc-5001 — the real one, placeholder gone');
  assert.equal(rowsForFiling[0].parse_status, 'ok');
  assert.equal(rowsForFiling[0].asset_name, 'Apple Inc.');
});

test('supersession is symmetric: a transient re-fetch failure must never downgrade a filing that already has real rows', async () => {
  // Seed: filing abc-7001 already has a real, successfully-parsed row.
  await store.save([realRow({ id: 'real-7001', source_id: 'abc-7001|0', filing_id: 'abc-7001', content_hash: 'h7001' })]);
  const existing = await store.query({ limit: 100 });
  assert.equal(existing.filter((t) => t.filing_id === 'abc-7001').length, 1);

  // A later run has a transient fetch failure for the SAME filing.
  const incoming = [placeholderRow({ id: 'ph-7001', source_id: 'abc-7001|fetch_failed', filing_id: 'abc-7001' })];

  const existingRealFilingIds = new Set(
    existing.filter((t) => t.parse_status === 'ok').map((t) => t.filing_id),
  );
  const PLACEHOLDER_STATUSES = new Set(['fetch_failed', 'scanned_unparsed', 'parse_failed']);
  const filtered = incoming.filter((t) => {
    const isPlaceholder = PLACEHOLDER_STATUSES.has(t.parse_status);
    return !(isPlaceholder && existingRealFilingIds.has(t.filing_id));
  });

  assert.equal(filtered.length, 0, 'the placeholder must be discarded, not written, since real data already exists');

  const final = await store.query({ limit: 100 });
  const rowsForFiling = final.filter((t) => t.filing_id === 'abc-7001');
  assert.equal(rowsForFiling.length, 1);
  assert.equal(rowsForFiling[0].parse_status, 'ok');
});
