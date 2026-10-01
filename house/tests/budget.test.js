const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planWithinBudget, saveWithinBudget, DEFAULT_DATASET_ITEM_EVENT } = require('../dist/store/budget.js');
const { buildRunSummary } = require('../dist/utils/runSummary.js');

// The incident: run IDgg2nQSlsPoPxJhr ended SUCCEEDED with 475 rows —
// (1 − 0.05) / 0.002 = 475 — a $1 max charge, $0.05 already spent (actor
// start), $0.002 per row. The rows came out alphabetical by member, so the
// cut silently dropped everyone after "H".

function snapshot(overrides = {}) {
  return {
    isPayPerEvent: true,
    maxTotalChargeUsd: 1,
    perEventPrices: { 'apify-actor-start': 0.05, [DEFAULT_DATASET_ITEM_EVENT]: 0.002 },
    chargedCounts: { 'apify-actor-start': 1, [DEFAULT_DATASET_ITEM_EVENT]: 0 },
    ...overrides,
  };
}
const okRows = (n) => Array.from({ length: n }, () => true);

test('planWithinBudget reproduces the 475-row cap from the incident', () => {
  const plan = planWithinBudget(okRows(900), 'transaction', snapshot());
  assert.equal(plan.keep, 475);
  assert.equal(plan.truncated, true);
});

test('planWithinBudget: everything fits / exactly fills the budget -> not truncated', () => {
  assert.equal(planWithinBudget(okRows(100), 'transaction', snapshot()).truncated, false);
  const exact = planWithinBudget(okRows(475), 'transaction', snapshot());
  assert.equal(exact.keep, 475);
  assert.equal(exact.truncated, false);
});

test('planWithinBudget: a separate "transaction" event is billed for ok/ocr rows only; placeholders cost the item price only', () => {
  const snap = snapshot({
    perEventPrices: { 'apify-actor-start': 0, [DEFAULT_DATASET_ITEM_EVENT]: 0, transaction: 0.01 },
    chargedCounts: {},
    maxTotalChargeUsd: 0.05,
  });
  // 5 billable rows fit; rows: F T T F T T T T(6th billable) F -> keep stops before it.
  const plan = planWithinBudget([false, true, true, false, true, true, true, true, false], 'transaction', snap);
  assert.equal(plan.keep, 7);
  assert.equal(plan.truncated, true);
});

test('planWithinBudget: not pay-per-event, or no finite cap -> never truncates', () => {
  assert.equal(planWithinBudget(okRows(1000), 'transaction', snapshot({ isPayPerEvent: false })).truncated, false);
  assert.equal(planWithinBudget(okRows(1000), 'transaction', snapshot({ maxTotalChargeUsd: Infinity })).truncated, false);
});

function tx(i, parse_status = 'ok') {
  return { id: String(i), parse_status, filing_date: '2026-09-01' };
}

test('saveWithinBudget pushes only what fits (the first = newest rows) and reports truncation', async () => {
  const pushed = [];
  const result = await saveWithinBudget(Array.from({ length: 600 }, (_, i) => tx(i)), {
    snapshot: () => snapshot(),
    push: async (rows) => { pushed.push(...rows); },
  });
  assert.equal(pushed.length, 475);
  assert.equal(pushed[474].id, '474');
  assert.deepEqual([result.saved, result.notSaved, result.truncated, result.reason], [475, 125, true, 'max_total_charge_reached']);
});

test('saveWithinBudget: placeholders and OCR rows are pushed like any row and consume the budget (no separate charge step exists)', async () => {
  const pushed = [];
  const statuses = ['ok', 'scanned_unparsed', 'ocr', 'parse_failed', 'fetch_failed'];
  const rows = Array.from({ length: 600 }, (_, i) => tx(i, statuses[i % statuses.length]));
  const result = await saveWithinBudget(rows, { snapshot: () => snapshot(), push: async (r) => { pushed.push(...r); } });
  assert.equal(pushed.length, 475, 'four fifths of the rows are non-"ok" and the cap is unchanged');
  assert.equal(result.truncated, true);
});

test('saveWithinBudget: SaveDeps has no charge hook — the push is the charge; empty input does nothing', async () => {
  const ok = await saveWithinBudget([tx(0), tx(1, 'parse_failed')], { snapshot: () => snapshot({ isPayPerEvent: false }), push: async () => {} });
  assert.deepEqual([ok.saved, ok.truncated], [2, false]);
  const none = await saveWithinBudget([], {
    snapshot: () => { throw new Error('unused'); }, push: async () => { throw new Error('unused'); },
  });
  assert.deepEqual(none, { saved: 0, truncated: false, notSaved: 0 });
});

function stats(overrides = {}) {
  return {
    inserted: 475, skipped: 0, errors: 0, windowFrom: '2026-07-03', windowTo: '2026-10-01', truncated: true,
    truncationReason: 'max_total_charge_reached', rowsEmitted: 475, rowsNotEmitted: 125, lastFilingDate: '2026-07-21',
    lastFilingId: '20035001', duplicatesRemoved: 0, skippedByMemberCount: 0, skippedByTransactionDateCount: 0,
    filteredByTickerCount: 0, filteredByTransactionDateCount: 0, placeholdersExcludedCount: 0, ...overrides,
  };
}

test('RUN_SUMMARY carries truncated / reason / rowsEmitted / lastFilingDate; a complete run says truncated:false', () => {
  const s = buildRunSummary(stats());
  assert.deepEqual([s.truncated, s.reason, s.rowsEmitted, s.lastFilingDate, s.rowsNotEmitted], [true, 'max_total_charge_reached', 475, '2026-07-21', 125]);
  const ok = buildRunSummary(stats({ truncated: false, truncationReason: undefined, rowsNotEmitted: 0 }));
  assert.deepEqual([ok.truncated, ok.reason], [false, null]);
});

// ─── Placeholders and the "Transaction record" event ──────────────────────────
// Pricing as published on the Actor (public store API, read 2026-10-01): the
// ONLY per-record event is "apify-default-dataset-item" ("Transaction
// record", $0.002 FREE tier) plus "apify-actor-start" ($0.05). There is no
// custom "transaction" event. Per the SDK (apify@3.7.0, charging.js:298) that
// synthetic event is "tracked locally only, the platform handles [it]
// automatically based on dataset writes": every row written to the DEFAULT
// dataset is billed by the platform whatever its parse_status, and every SDK
// client is the patched one (actor.js newClient). A placeholder therefore
// cannot be exempted without keeping it out of the default dataset. These
// tests pin the budget math to that reality; they do NOT claim placeholders
// are free.

test('under the real pricing a placeholder consumes budget exactly like a transaction row', () => {
  const real = snapshot(); // 0.05 start + 0.002 per default-dataset item, $1 cap
  assert.equal(planWithinBudget(okRows(600), 'transaction', real).keep, 475);
  // 7 of the 475 in the incident were scanned_unparsed placeholders: they were not exempt.
  const mixed = planWithinBudget(Array.from({ length: 600 }, (_, i) => i % 70 !== 0), 'transaction', real);
  assert.equal(mixed.keep, 475);
});

test('the "transaction" event is unpriced (so the removed Actor.charge call could never have charged anything)', () => {
  assert.equal(snapshot().perEventPrices.transaction, undefined);
});

test('RUN_SUMMARY exposes placeholdersWithheld and duplicatesCollapsed (and keeps the older names)', () => {
  const s = buildRunSummary(stats({ duplicatesRemoved: 4, placeholdersExcludedCount: 3 }));
  assert.equal(s.duplicatesCollapsed, 4);
  assert.equal(s.placeholdersWithheld, 3);
  assert.equal(s.duplicatesRemoved, 4);
  assert.equal(s.placeholdersExcludedCount, 3);
});
