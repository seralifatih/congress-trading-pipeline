import { createHash } from 'crypto';
import type { RawTransaction, Transaction } from '../types/index.js';

// ─── Dedup key ────────────────────────────────────────────────────────────────
// Per CLAUDE.md: politician + transaction_date + asset_name + amount, PLUS
// source_id (doc id + marker/row ordinal within it). A single House PTR PDF
// can legitimately contain multiple line items identical on every other
// field (same-day, same-security split transactions) — those are distinct
// real transactions, not duplicates, so source_id is required to keep the
// key (and the derived id) unique.
// amount_max can be null ("Over $X"), coerce to empty string so key stays stable.

export function dedupKey(t: Transaction): string {
  return [
    t.politician.toLowerCase().trim(),
    t.transaction_date.toLowerCase().trim(),
    t.asset_name.toLowerCase().trim(),
    String(t.amount_min),
    t.amount_max === null ? '' : String(t.amount_max),
    t.source_id,
  ].join('|');
}

// ─── Stable primary key ───────────────────────────────────────────────────────
// SHA-256 of the dedup key — used as the storage primary key.

export function generateId(transaction: Transaction): string {
  return createHash('sha256').update(dedupKey(transaction)).digest('hex');
}

// ─── Content fingerprint ──────────────────────────────────────────────────────
// SHA-256 of politician|transaction_date|asset_name|type|amount_min|amount_max
// |owner — deliberately EXCLUDING source_id. This is additive: it does not
// change how `id` is computed.
//
// Two rows can legitimately share a content_hash:
//   - WITHIN the same source document: a genuine separate tranche.
//   - ACROSS different source documents: the same real-world transaction
//     reported more than once (e.g. a duplicate PTR filing, or a filing that
//     re-lists a row also present under a different docId) — keep both; do
//     not deduplicate. Consumers decide what to do with the match.
// This function never drops or merges rows — it only labels them so a
// consumer can detect the cross-document case. See README "Duplicate
// transactions across filings" for a worked example.

export function computeContentHash(t: Transaction): string {
  const key = [
    t.politician.toLowerCase().trim(),
    t.transaction_date.toLowerCase().trim(),
    t.asset_name.toLowerCase().trim(),
    t.type,
    String(t.amount_min),
    t.amount_max === null ? '' : String(t.amount_max),
    t.owner,
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
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
