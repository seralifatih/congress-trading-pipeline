import { createHash } from 'crypto';
import type { RawTransaction, Transaction } from '../types/index.js';

// ─── Dedup key ────────────────────────────────────────────────────────────────
// Per CLAUDE.md: politician + transaction_date + asset_name + amount
// amount_max can be null ("Over $X"), coerce to empty string so key stays stable.

export function dedupKey(t: Transaction): string {
  return [
    t.politician.toLowerCase().trim(),
    t.transaction_date.toLowerCase().trim(),
    t.asset_name.toLowerCase().trim(),
    String(t.amount_min),
    t.amount_max === null ? '' : String(t.amount_max),
  ].join('|');
}

// ─── Stable primary key ───────────────────────────────────────────────────────
// SHA-256 of the dedup key — used as the storage primary key.

export function generateId(transaction: Transaction): string {
  return createHash('sha256').update(dedupKey(transaction)).digest('hex');
}

// ─── Deduplication ────────────────────────────────────────────────────────────

export function dedup(incoming: Transaction[], existing: Transaction[]): Transaction[] {
  const existingKeys = new Set(existing.map(dedupKey));
  return incoming.filter((t) => !existingKeys.has(dedupKey(t)));
}

// ─── Legacy helper (kept for store/interface.ts compatibility) ────────────────

export function filterNewTrades(
  incoming: RawTransaction[],
  existingIds: Set<string>,
): RawTransaction[] {
  return incoming.filter((t) => !existingIds.has(t.source_id));
}
