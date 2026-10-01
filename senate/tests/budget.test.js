const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planWithinBudget, saveWithinBudget, DEFAULT_DATASET_ITEM_EVENT } = require('../dist/store/budget.js');
const { buildRunSummary } = require('../dist/utils/runSummary.js');

// The incident: run vyb2mlSRWe0HiZSeT ended SUCCEEDED with 316 rows —
// (1 − 0.05) / 0.003 = 316.67 — i.e. a $1 max charge, $0.05 already spent
// (actor start), $0.003 per row. Numbers below reproduce exactly that.

function snapshot(overrides = {}) {
  return {
    isPayPerEvent: true,
    maxTotalChargeUsd: 1,
    perEventPrices: { 'apify-actor-start': 0.05, [DEFAULT_DATASET_ITEM_EVENT]: 0.003 },
    chargedCounts: { 'apify-actor-start': 1, [DEFAULT_DATASET_ITEM_EVENT]: 0 },
    ...overrides,
  };
}

const okRows = (n) => Array.from({ length: n }, () => true);

test('planWithinBudget reproduces the 316-row cap from the incident', () => {
  const plan = planWithinBudget(okRows(500), 'transaction', snapshot());
  assert.equal(plan.keep, 316);
  assert.equal(plan.truncated, true);
});

test('planWithinBudget: everything fits -> not truncated', () => {
  const plan = planWithinBudget(okRows(100), 'transaction', snapshot());
  assert.equal(plan.keep, 100);
  assert.equal(plan.truncated, false);
});

test('planWithinBudget: exactly filling the budget is NOT truncation', () => {
  const plan = planWithinBudget(okRows(316), 'transaction', snapshot());
  assert.equal(plan.keep, 316);
  assert.equal(plan.truncated, false);
});

test('planWithinBudget: a separate "transaction" event is added for billable rows only; placeholders cost the item price only', () => {
  const snap = snapshot({
    perEventPrices: { 'apify-actor-start': 0, [DEFAULT_DATASET_ITEM_EVENT]: 0, transaction: 0.01 },
    chargedCounts: {},
    maxTotalChargeUsd: 0.05,
  });
  // 5 billable rows fit ($0.05 / $0.01); free placeholders cost nothing.
  // Rows: F T T F T T T T(6th billable, index 7) F  -> keep stops before index 7.
  const plan = planWithinBudget([false, true, true, false, true, true, true, true, false], 'transaction', snap);
  assert.equal(plan.keep, 7);
  assert.equal(plan.truncated, true);
});

test('planWithinBudget: not pay-per-event, or no finite cap -> never truncates', () => {
  assert.equal(planWithinBudget(okRows(1000), 'transaction', snapshot({ isPayPerEvent: false })).truncated, false);
  assert.equal(planWithinBudget(okRows(1000), 'transaction', snapshot({ maxTotalChargeUsd: Infinity })).truncated, false);
});

test('planWithinBudget: budget already spent -> keeps nothing', () => {
  const plan = planWithinBudget(okRows(10), 'transaction', snapshot({ chargedCounts: { 'apify-actor-start': 1, [DEFAULT_DATASET_ITEM_EVENT]: 317 } }));
  assert.equal(plan.keep, 0);
  assert.equal(plan.truncated, true);
});

function tx(i, parse_status = 'ok') {
  return { id: String(i), parse_status, filing_date: '2026-09-01' };
}

test('saveWithinBudget pushes only what fits (the first = newest rows) and reports truncation', async () => {
  const pushed = [];
  const result = await saveWithinBudget(
    Array.from({ length: 400 }, (_, i) => tx(i)),
    {
      snapshot: () => snapshot(),
      push: async (rows) => { pushed.push(...rows); },
    },
  );
  assert.equal(pushed.length, 316);
  assert.equal(pushed[0].id, '0');
  assert.equal(pushed[315].id, '315', 'the cap cuts the tail, keeping the first (newest) rows');
  assert.equal(result.saved, 316);
  assert.equal(result.notSaved, 84);
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'max_total_charge_reached');
});

test('saveWithinBudget: placeholders are pushed like any row and consume the budget (no separate charge step exists)', async () => {
  const pushed = [];
  const rows = Array.from({ length: 400 }, (_, i) => tx(i, i % 4 === 0 ? 'scanned_unparsed' : 'ok'));
  const result = await saveWithinBudget(rows, {
    snapshot: () => snapshot(),
    push: async (r) => { pushed.push(...r); },
  });
  assert.equal(pushed.length, 316, 'a quarter of the rows are placeholders and the cap is unchanged');
  assert.equal(pushed.filter((t) => t.parse_status === 'scanned_unparsed').length, 79);
  assert.equal(result.truncated, true);
});

test('saveWithinBudget: SaveDeps has no charge hook — the push is the charge', async () => {
  const result = await saveWithinBudget([tx(0), tx(1, 'parse_failed')], {
    snapshot: () => snapshot({ isPayPerEvent: false }),
    push: async () => {},
  });
  assert.deepEqual([result.saved, result.truncated], [2, false]);
});

test('saveWithinBudget: nothing to save', async () => {
  const result = await saveWithinBudget([], {
    snapshot: () => { throw new Error('should not be read'); },
    push: async () => { throw new Error('should not push'); },
  });
  assert.deepEqual(result, { saved: 0, truncated: false, notSaved: 0 });
});

// ─── RUN_SUMMARY ──────────────────────────────────────────────────────────────

function stats(overrides = {}) {
  return {
    inserted: 316, skipped: 0, errors: 0, windowFrom: '2026-07-03', windowTo: '2026-10-01',
    truncated: true, truncationReason: 'max_total_charge_reached', rowsEmitted: 316, rowsNotEmitted: 84,
    lastFilingDate: '2026-08-05', lastFilingId: 'abc', duplicatesRemoved: 0, skippedByMemberCount: 0,
    skippedByTransactionDateCount: 0, filteredByTickerCount: 0, filteredByTransactionDateCount: 0, placeholdersExcludedCount: 0,
    ...overrides,
  };
}

test('RUN_SUMMARY carries truncated / reason / rowsEmitted / lastFilingDate', () => {
  const s = buildRunSummary(stats());
  assert.equal(s.truncated, true);
  assert.equal(s.reason, 'max_total_charge_reached');
  assert.equal(s.rowsEmitted, 316);
  assert.equal(s.lastFilingDate, '2026-08-05');
  assert.equal(s.rowsNotEmitted, 84);
});

test('RUN_SUMMARY on a complete run: truncated false, reason null', () => {
  const s = buildRunSummary(stats({ truncated: false, truncationReason: undefined, rowsNotEmitted: 0 }));
  assert.equal(s.truncated, false);
  assert.equal(s.reason, null);
});

// ─── Placeholders and the "Transaction record" event ──────────────────────────
// Pricing as published on the Actor (public store API, read 2026-10-01): the
// ONLY per-record event is "apify-default-dataset-item" ("Transaction
// record", $0.003 FREE tier) plus "apify-actor-start" ($0.05). There is no
// custom "transaction" event. Per the SDK (apify@3.7.0, charging.js:298)
// that synthetic event is "tracked locally only, the platform handles [it]
// automatically based on dataset writes" — every row written to the DEFAULT
// dataset is billed by the platform, whatever its parse_status, and every
// client the SDK builds is the patched one (actor.js newClient). A
// placeholder therefore cannot be exempted without being kept out of the
// default dataset. These tests pin the budget math to that reality; they do
// NOT claim placeholders are free.

const REAL_PRICING = {
  isPayPerEvent: true,
  maxTotalChargeUsd: 1,
  perEventPrices: { 'apify-actor-start': 0.05, [DEFAULT_DATASET_ITEM_EVENT]: 0.003 },
  chargedCounts: { 'apify-actor-start': 1, [DEFAULT_DATASET_ITEM_EVENT]: 0 },
};

test('under the real pricing a placeholder consumes budget exactly like a transaction row', () => {
  const allOk = planWithinBudget(Array.from({ length: 400 }, () => true), 'transaction', REAL_PRICING);
  const mixed = planWithinBudget(Array.from({ length: 400 }, (_, i) => i % 10 !== 0), 'transaction', REAL_PRICING);
  assert.equal(allOk.keep, 316);
  assert.equal(mixed.keep, 316, 'placeholders (every 10th row) are not exempt from the cap');
});

test('the "transaction" event is unpriced (so the removed Actor.charge call could never have charged anything)', () => {
  assert.equal(REAL_PRICING.perEventPrices.transaction, undefined);
  const withTx = planWithinBudget(Array.from({ length: 400 }, () => true), 'transaction', { ...REAL_PRICING, perEventPrices: { ...REAL_PRICING.perEventPrices } });
  assert.equal(withTx.keep, 316);
});

test('RUN_SUMMARY exposes placeholdersWithheld and duplicatesCollapsed (and keeps the older names)', () => {
  const s = buildRunSummary(stats({ duplicatesRemoved: 17, placeholdersExcludedCount: 2 }));
  assert.equal(s.duplicatesCollapsed, 17);
  assert.equal(s.placeholdersWithheld, 2);
  assert.equal(s.duplicatesRemoved, 17);
  assert.equal(s.placeholdersExcludedCount, 2);
});
