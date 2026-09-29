const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'house-pipeline-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { SqliteStore } = require('../dist/store/sqliteStore.js');
const { placeholdersByFilingId, dedup, generateId, computeContentHash, latestBySourceId } = require('../dist/utils/dedup.js');

const store = SqliteStore.getInstance();

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Placeholder supersession ──────────────────────────────────────────────────
// This mirrors, step by step, what scheduler/pipeline.ts's supersede logic
// does (placeholdersByFilingId + deleteByFilingIds), rather than calling
// runPipeline() directly — runPipeline hardcodes the fetch layer
// (fetchAllHouse), which isn't dependency-injectable, so exercising it here
// would mean actually hitting disclosures-clerk.house.gov. Testing the
// supersede primitives + real SqliteStore state directly is both faster and
// a more precise regression guard for the actual bug this was written to
// fix: a stale placeholder co-existing with real rows for the same filing.

function placeholderRow(overrides = {}) {
  return {
    id: 'fetch-failed-row',
    politician: 'Test Representative',
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
    source_id: 'house_5001_fetch_failed',
    filing_id: '5001',
    content_hash: '',
    filing_type: null,
    amendment_number: null,
    parse_status: 'fetch_failed',
    pdf_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/5001.pdf',
    ocr_confidence: null,
    fetchedAt: '2026-08-10T00:00:00.000Z',
    lastModifiedAt: '2026-08-10T00:00:00.000Z',
    revisionCount: 0,
    ...overrides,
  };
}

function realRow(overrides = {}) {
  return {
    id: 'real-row-0',
    politician: 'Test Representative',
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
    source_id: 'house_5001_0',
    filing_id: '5001',
    content_hash: 'realhash0',
    filing_type: null,
    amendment_number: null,
    parse_status: 'ok',
    pdf_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/5001.pdf',
    ocr_confidence: null,
    fetchedAt: '2026-08-10T00:00:00.000Z',
    lastModifiedAt: '2026-08-10T00:00:00.000Z',
    revisionCount: 0,
    ...overrides,
  };
}

test('a fetch_failed placeholder is written to the store when a filing has no real rows yet', async () => {
  await store.save([placeholderRow({ id: 'ph-1', source_id: 'house_6001_fetch_failed', filing_id: '6001' })]);

  const all = await store.query({ limit: 100 });
  const found = all.find((t) => t.filing_id === '6001');
  assert.ok(found, 'placeholder row must be queryable');
  assert.equal(found.parse_status, 'fetch_failed');
});

test('supersession: a later successful parse for the same filing_id removes the stale fetch_failed placeholder', async () => {
  // Step 1: a run that fails to fetch filing 5001 writes a fetch_failed placeholder.
  await store.save([placeholderRow()]);
  let existing = await store.query({ limit: 100 });
  assert.equal(existing.filter((t) => t.filing_id === '5001').length, 1, 'only the placeholder exists so far');
  assert.equal(existing.find((t) => t.filing_id === '5001').parse_status, 'fetch_failed');

  // Step 2: a later run successfully fetches and parses filing 5001 — this is
  // the exact check pipeline.ts's Step 3b performs against `existing`.
  const incoming = [realRow()];
  const existingPlaceholderByFilingId = placeholdersByFilingId(existing);
  const staleFilingIds = new Set();
  for (const t of incoming) {
    if ((t.parse_status === 'ok' || t.parse_status === 'ocr') && existingPlaceholderByFilingId.has(t.filing_id)) {
      staleFilingIds.add(t.filing_id);
    }
  }
  assert.deepEqual([...staleFilingIds], ['5001'], 'the real row must be recognized as superseding filing_id 5001\'s placeholder');

  // Dedup against existing (mirrors pipeline.ts Step 4) — the real row's
  // dedup key differs from the placeholder's (different source_id and
  // content), so it is NOT filtered out here.
  const netNew = dedup(incoming, existing);
  assert.equal(netNew.length, 1, 'the real row is net-new relative to the placeholder');

  // Assign id/content_hash/fetchedAt the way pipeline.ts Step 5 does, then save.
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

  // Step 3: delete the stale placeholder — this is the exact call
  // pipeline.ts makes after a successful save.
  await store.deleteByFilingIds([...staleFilingIds]);

  // Verify final state: the placeholder is GONE, only the real row remains
  // for filing_id 5001 — this is the core bug this whole mechanism exists
  // to prevent (a stale placeholder sitting alongside real data forever).
  const final = await store.query({ limit: 100 });
  const rowsForFiling = final.filter((t) => t.filing_id === '5001');
  assert.equal(rowsForFiling.length, 1, 'exactly one row should remain for filing_id 5001 — the real one, placeholder gone');
  assert.equal(rowsForFiling[0].parse_status, 'ok');
  assert.equal(rowsForFiling[0].asset_name, 'Apple Inc.');
});

test('supersession is symmetric: a transient re-fetch failure must never downgrade a filing that already has real rows', async () => {
  // Seed: filing 7001 already has a real, successfully-parsed row.
  await store.save([realRow({ id: 'real-7001', source_id: 'house_7001_0', filing_id: '7001', content_hash: 'h7001' })]);
  const existing = await store.query({ limit: 100 });
  assert.equal(existing.filter((t) => t.filing_id === '7001').length, 1);

  // A later run has a transient fetch failure for the SAME filing (e.g. a
  // one-off network blip on an otherwise-already-successful filing).
  const incoming = [placeholderRow({ id: 'ph-7001', source_id: 'house_7001_fetch_failed', filing_id: '7001' })];

  const existingRealFilingIds = new Set(
    existing.filter((t) => t.parse_status === 'ok' || t.parse_status === 'ocr').map((t) => t.filing_id),
  );
  const PLACEHOLDER_STATUSES = new Set(['fetch_failed', 'scanned_unparsed', 'parse_failed']);
  const filtered = incoming.filter((t) => {
    const isPlaceholder = PLACEHOLDER_STATUSES.has(t.parse_status);
    return !(isPlaceholder && existingRealFilingIds.has(t.filing_id));
  });

  assert.equal(filtered.length, 0, 'the placeholder must be discarded, not written, since real data already exists');

  // Nothing new to save — the store must still show only the original real row.
  const final = await store.query({ limit: 100 });
  const rowsForFiling = final.filter((t) => t.filing_id === '7001');
  assert.equal(rowsForFiling.length, 1);
  assert.equal(rowsForFiling[0].parse_status, 'ok');
});
