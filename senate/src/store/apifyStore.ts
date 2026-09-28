import { Actor, Dataset } from 'apify';
import type { Transaction, QueryFilters, StoreAdapter } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('apifyStore');

// On pay-per-event pricing (configured on the Actor's Pricing tab in the
// Apify console — no local pricing file needed), this is the event name that
// tab must register. Actor.charge() is safe to call even when the Actor is
// NOT on pay-per-event pricing — it logs a warning once and no-ops rather
// than throwing — so this call is unconditional, not feature-detected.
const TRANSACTION_CHARGE_EVENT = 'transaction';

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

  async save(transactions: Transaction[]): Promise<void> {
    if (transactions.length === 0) return;
    const dataset = await Dataset.open();
    await dataset.pushData(transactions);

    // Every row is written to the dataset either way — a paper-filing
    // placeholder is still real, useful output (it tells a consumer the
    // filing exists and where to find it). But it carries no transaction
    // data, so only a parse_status "ok" row is a billable result.
    const billable = transactions.filter((t) => t.parse_status === 'ok').length;
    if (billable > 0) {
      await Actor.charge({ eventName: TRANSACTION_CHARGE_EVENT, count: billable });
    }

    log.info(
      `Pushed ${transactions.length} items to Apify Dataset ` +
      `(${billable} billed as '${TRANSACTION_CHARGE_EVENT}', ${transactions.length - billable} free placeholder(s))`,
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
