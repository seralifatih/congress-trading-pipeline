const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fetcher = require('../dist/fetcher/houseFetcher.js');
const { parseInput, toPipelineOptions } = require('../dist/utils/input.js');
const { runPipeline } = require('../dist/scheduler/pipeline.js');

// Bug: apify.ts used to do  process.env['FETCH_DAYS_BACK'] = ...  (and
// DEBUG_PTR_LIMIT, ENABLE_OCR) AFTER config.ts / houseFetcher.ts had already
// read process.env at import time, so the Actor input never took effect —
// run IDgg2nQSlsPoPxJhr asked for fetchDaysBack=30 and got 90 days.

test('apify.ts source no longer assigns the ignored env vars; it passes toPipelineOptions(input) to runPipeline', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apify.ts'), 'utf8');
  assert.doesNotMatch(src, /process\.env\[['"](FETCH_DAYS_BACK|DEBUG_PTR_LIMIT|ENABLE_OCR)['"]\]\s*=/);
  assert.match(src, /runPipeline\(store,\s*toPipelineOptions\(input\)\)/);
  // DEBUG_PDF_TEXT is the one env var that IS read at call time, so it may stay.
  assert.match(src, /DEBUG_PDF_TEXT/);
});

test('fetchDaysBack and debugPtrLimit from the Actor input reach fetchAllHouse', async () => {
  const calls = [];
  const original = fetcher.fetchAllHouse;
  fetcher.fetchAllHouse = async (from, to, options) => {
    calls.push({ from, to, options });
    return { success: true, records: [], fetchFailedCount: 0, parseFailedCount: 0, ocrFilingCount: 0, ocrRowCount: 0 };
  };
  try {
    const input = parseInput({ fetchDaysBack: 30, debugPtrLimit: 2, enableOcr: true, members: ['Nancy Pelosi'], transactionDateFrom: '2026-09-01' });
    const stats = await runPipeline({ save: async () => {}, query: async () => [], deleteByFilingIds: async () => {} }, { ...toPipelineOptions(input), resolver: null });

    assert.equal(calls.length, 1);
    const { from, to, options } = calls[0];
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
    assert.equal(days, 30, `window must be 30 days, got ${from}..${to}`);
    assert.equal(options.debugPtrLimit, 2);
    assert.equal(options.enableOcr, true);
    assert.equal(typeof options.memberMatcher, 'function');
    assert.equal(options.transactionDateFrom, '2026-09-01');
    assert.equal(stats.windowFrom, from);
    assert.equal(stats.windowTo, to);
  } finally {
    fetcher.fetchAllHouse = original;
  }
});

test('without fetchDaysBack the default is still 90 days (backward compatible)', async () => {
  const calls = [];
  const original = fetcher.fetchAllHouse;
  fetcher.fetchAllHouse = async (from, to) => {
    calls.push([from, to]);
    return { success: true, records: [], fetchFailedCount: 0, parseFailedCount: 0, ocrFilingCount: 0, ocrRowCount: 0 };
  };
  try {
    await runPipeline({ save: async () => {}, query: async () => [], deleteByFilingIds: async () => {} }, { ...toPipelineOptions(parseInput({})), resolver: null });
    const [from, to] = calls[0];
    assert.equal(Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000), 90);
  } finally {
    fetcher.fetchAllHouse = original;
  }
});
