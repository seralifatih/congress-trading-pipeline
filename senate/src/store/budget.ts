import type { SaveResult, Transaction } from '../types/index.js';

// Pay-per-event charge-cap handling, kept free of the Apify SDK so it can be
// unit-tested with plain numbers. ApifyStore wires the real ChargingManager
// into these functions.
//
// Why this exists: when a run's max total charge is reached, the SDK does not
// throw — it silently trims the rows it will push (the patched dataset client
// limits pushData by the `apify-default-dataset-item` price) and/or returns a
// partial ChargeResult. Without checking, the run finishes SUCCEEDED with
// less data than the window contained and no signal. Verified against
// apify@3.7.0: ChargeResult { eventChargeLimitReached, chargedCount,
// chargeableWithinLimit } (dist/charging.d.ts) and
// ChargingManager.getPricingInfo()/getMaxTotalChargeUsd()/getChargedEventCount().

export const DEFAULT_DATASET_ITEM_EVENT = 'apify-default-dataset-item';

export interface BudgetSnapshot {
  isPayPerEvent: boolean;
  maxTotalChargeUsd: number;
  perEventPrices: Record<string, number>;
  chargedCounts: Record<string, number>;
}

export interface BudgetPlan {
  /** How many leading rows fit in the remaining budget. */
  keep: number;
  truncated: boolean;
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}

/**
 * How many of `rows` (in order) can still be paid for. A row costs the
 * default-dataset-item price (every pushed row, if that event is priced) plus
 * the billable event's price when the row is billable. (The Actor has no such
 * custom event, so the caller passes all-false and every row costs the item price.)
 * Mirrors the SDK's own arithmetic: remaining = maxTotalChargeUsd − Σ price ×
 * chargedCount.
 */
export function planWithinBudget(
  billable: boolean[],
  billableEvent: string,
  snapshot: BudgetSnapshot,
): BudgetPlan {
  if (!snapshot.isPayPerEvent || !Number.isFinite(snapshot.maxTotalChargeUsd)) {
    return { keep: billable.length, truncated: false };
  }

  const spent = Object.entries(snapshot.perEventPrices).reduce(
    (sum, [name, price]) => sum + price * (snapshot.chargedCounts[name] ?? 0),
    0,
  );
  const remaining = round6(snapshot.maxTotalChargeUsd - spent);
  const itemPrice = snapshot.perEventPrices[DEFAULT_DATASET_ITEM_EVENT] ?? 0;
  const billablePrice = snapshot.perEventPrices[billableEvent] ?? 0;

  let cumulative = 0;
  let keep = 0;
  for (const isBillable of billable) {
    cumulative = round6(cumulative + itemPrice + (isBillable ? billablePrice : 0));
    if (cumulative > remaining) break;
    keep++;
  }
  return { keep, truncated: keep < billable.length };
}

export interface SaveDeps {
  snapshot(): BudgetSnapshot;
  push(rows: Transaction[]): Promise<void>;
}

/**
 * Push as many rows as the remaining budget covers and report whether
 * anything was left out. Rows are pushed in the order given, so a cap always
 * cuts the tail (the pipeline hands them newest-first).
 *
 * There is deliberately no separate "charge" step: the Actor's only priced
 * per-record event is the platform's `apify-default-dataset-item`
 * ("Transaction record"), which the platform bills for EVERY row written to
 * the default dataset — placeholders included. The push itself is the charge.
 */
export async function saveWithinBudget(
  transactions: Transaction[],
  deps: SaveDeps,
): Promise<SaveResult> {
  if (transactions.length === 0) return { saved: 0, truncated: false, notSaved: 0 };

  // No per-row custom event exists, so every row costs the item price alone.
  const plan = planWithinBudget(transactions.map(() => false), '', deps.snapshot());
  const toSave = transactions.slice(0, plan.keep);
  if (toSave.length > 0) await deps.push(toSave);

  return {
    saved: toSave.length,
    truncated: plan.truncated,
    reason: plan.truncated ? 'max_total_charge_reached' : undefined,
    notSaved: transactions.length - toSave.length,
  };
}
