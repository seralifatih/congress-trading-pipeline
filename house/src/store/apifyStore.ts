import { Actor, Dataset } from 'apify';
import type { Transaction, QueryFilters, StoreAdapter, SaveResult } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';
import { saveWithinBudget, type BudgetSnapshot } from './budget.js';

const log = makeLogger('apifyStore');

// Billing: the Actor's only priced per-record event is the platform's
// 'apify-default-dataset-item' ("Transaction record"), billed for EVERY item
// written to the default dataset — placeholder rows included (checked against
// the published pricing and apify@3.7.0 charging.js: "the platform handles
// them automatically based on dataset writes"). The push is therefore the
// charge; there is no separate Actor.charge() call (an earlier one targeted an
// unregistered 'transaction' event and only logged a warning).

function budgetSnapshot(): BudgetSnapshot {
  const manager = Actor.getChargingManager();
  const pricing = manager.getPricingInfo();
  const chargedCounts: Record<string, number> = {};
  for (const name of Object.keys(pricing.perEventPrices)) {
    chargedCounts[name] = manager.getChargedEventCount(name);
  }
  return {
    isPayPerEvent: pricing.isPayPerEvent,
    maxTotalChargeUsd: pricing.maxTotalChargeUsd,
    perEventPrices: pricing.perEventPrices,
    chargedCounts,
  };
}

// ─── ApifyStore ───────────────────────────────────────────────────────────────
// Writes transactions to the actor's default Dataset — persisted by Apify
// platform across runs and accessible via the API after the actor exits.
//
// query() loads the full dataset into memory for dedup. Fine for 90-day
// windows (~10K records); revisit if volume grows significantly.

export class ApifyStore implements StoreAdapter {
  private static instance: ApifyStore | null = null;

  static getInstance(): ApifyStore {
    if (!ApifyStore.instance) {
      ApifyStore.instance = new ApifyStore();
    }
    return ApifyStore.instance;
  }

  async save(transactions: Transaction[]): Promise<SaveResult> {
    if (transactions.length === 0) return { saved: 0, truncated: false, notSaved: 0 };
    const dataset = await Dataset.open();

    const result = await saveWithinBudget(transactions, {
      snapshot: budgetSnapshot,
      push: (rows) => dataset.pushData(rows),
    });

    log.info(
      `Pushed ${result.saved} items to Apify Dataset (each billed by the platform as a ` +
      `'Transaction record', placeholders included)`,
    );
    if (result.truncated) {
      log.warn(
        `Max total charge reached — ${result.notSaved} row(s) were NOT written. ` +
        `Raise the run's maximum charge (or narrow the window/filters) to get them.`,
      );
    }
    return result;
  }

  // Apify Dataset has no delete API (append-only, pushData-only) — a stale
  // placeholder written on a prior run physically stays in the dataset
  // forever. This is a real, documented platform limitation (see
  // house/README.md Coverage section), not something worked around here.
  // The pipeline still calls this on every run (same as SqliteStore) so the
  // supersede logic is uniform across both stores; here it just logs so the
  // gap is visible in run output rather than silently doing nothing.
  async deleteByFilingIds(filingIds: string[]): Promise<void> {
    if (filingIds.length === 0) return;
    log.warn(
      `deleteByFilingIds: Apify Dataset has no delete API — ${filingIds.length} stale ` +
      `placeholder row(s) for filing_id(s) [${filingIds.slice(0, 5).join(', ')}${filingIds.length > 5 ? ', ...' : ''}] ` +
      `remain in the dataset alongside the new, correct rows written this run. Consumers ` +
      `should filter to the latest row per filing_id by lastModifiedAt, or filter ` +
      `parse_status="ok"/"ocr" to see only real transaction data.`,
    );
  }

  async query(filters: QueryFilters = {}): Promise<Transaction[]> {
    const dataset = await Dataset.open();
    const { items } = await dataset.getData({ clean: true });
    let rows = items as Transaction[];

    if (filters.politician) {
      const q = filters.politician.toLowerCase();
      rows = rows.filter((r) => r.politician.toLowerCase().includes(q));
    }
    if (filters.ticker) {
      const t = filters.ticker.toUpperCase();
      rows = rows.filter((r) => r.ticker === t);
    }
    if (filters.type) rows = rows.filter((r) => r.type === filters.type);
    if (filters.owner) rows = rows.filter((r) => r.owner === filters.owner);
    if (filters.parse_status) rows = rows.filter((r) => r.parse_status === filters.parse_status);
    if (filters.date_from) rows = rows.filter((r) => r.transaction_date !== null && r.transaction_date >= filters.date_from!);
    if (filters.date_to)   rows = rows.filter((r) => r.transaction_date !== null && r.transaction_date <= filters.date_to!);

    const offset = filters.offset ?? 0;
    const limit  = filters.limit  ?? 500;
    return rows.slice(offset, offset + limit);
  }
}
