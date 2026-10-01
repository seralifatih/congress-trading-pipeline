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
    (t.transaction_date ?? '').toLowerCase().trim(),
    (t.asset_name ?? '').toLowerCase().trim(),
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
    (t.transaction_date ?? '').toLowerCase().trim(),
    (t.asset_name ?? '').toLowerCase().trim(),
    t.type ?? '',
    String(t.amount_min),
    t.amount_max === null ? '' : String(t.amount_max),
    t.owner ?? '',
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

// ─── Cross-filing duplicate collapse ──────────────────────────────────────────
// The same real-world trade is routinely reported in more than one filing —
// an original PTR and the amendment that re-lists it, or two amendments that
// both carry the full table. Within a run's batch, rows with the same
// content_hash that come from DIFFERENT filings (filing_id) are exact
// duplicates: one copy is kept, the rest dropped. Which copy survives is the
// one from the highest-ranked filing — an amended filing (any row "Filing Status: Amended") first, then
// later filing_date, then earlier position in the batch (the listing is
// newest-first). An amendment's copy therefore always beats the original's;
// an amendment's rows are never the ones removed.
//
// Rows sharing a content_hash WITHIN one filing are left alone: a single PTR
// can legitimately list several identical tranches (see computeContentHash).
//
// Supersession is annotated only where the data itself shows it — the source
// has no "amends filing X" link. A surviving amendment row is stamped
// supersedes_filing_id = the lower-ranked filing it shares the most identical
// trades with; that lower-ranked filing's remaining rows get is_superseded.
// Anything without shared trades stays null/false: not determinable.

export interface CollapseResult {
  rows: Transaction[];
  duplicatesRemoved: number;
  supersessionsFound: number;
}

interface FilingRank {
  filing_id: string;
  filing_type: Transaction['filing_type'];
  amendment: number; // 0 for originals and unlabeled filings
  filing_date: string;
  firstIndex: number;
}

// > 0 when a outranks b.
function compareRank(a: FilingRank, b: FilingRank): number {
  if (a.amendment !== b.amendment) return a.amendment - b.amendment;
  if (a.filing_date !== b.filing_date) return a.filing_date > b.filing_date ? 1 : -1;
  return b.firstIndex - a.firstIndex;
}

export function collapseCrossFilingDuplicates(
  rows: Transaction[],
  options: { dropDuplicates: boolean } = { dropDuplicates: true },
): CollapseResult {
  const ranks = new Map<string, FilingRank>(); // key: filerKey|filing_id
  const groups = new Map<string, Map<string, number[]>>(); // filerKey|hash -> filing key -> row indices
  const filerKeyOf = (t: Transaction) => t.politician.toLowerCase().replace(/[^a-z]+/g, ' ').trim();

  rows.forEach((t, i) => {
    if ((t.parse_status !== 'ok' && t.parse_status !== 'ocr')) return;
    const fk = `${filerKeyOf(t)}|${t.filing_id}`;
    if (!ranks.has(fk)) {
      ranks.set(fk, {
        filing_id: t.filing_id,
        filing_type: t.filing_type,
        amendment: 0,
        filing_date: t.filing_date,
        firstIndex: i,
      });
    }
    // House labels amendments per ROW ("Filing Status: Amended"), not per
    // filing, and has no amendment number: a filing ranks as an amendment
    // when any of its rows is one.
    if (t.filing_type === 'amendment') ranks.get(fk)!.amendment = 1;
    const gk = `${filerKeyOf(t)}|${computeContentHash(t)}`;
    const byFiling = groups.get(gk) ?? new Map<string, number[]>();
    const idxs = byFiling.get(fk) ?? [];
    idxs.push(i);
    byFiling.set(fk, idxs);
    groups.set(gk, byFiling);
  });

  const dropped = new Set<number>();
  // winner filing key -> (loser filing key -> shared hash count), only for
  // pairs where the winner is a strictly later amendment.
  const supersedes = new Map<string, Map<string, number>>();
  const supersededFilings = new Set<string>();

  for (const byFiling of groups.values()) {
    if (byFiling.size < 2) continue;
    const filingKeys = [...byFiling.keys()];
    const winnerKey = filingKeys.reduce((best, k) =>
      compareRank(ranks.get(k)!, ranks.get(best)!) > 0 ? k : best,
    );
    const winner = ranks.get(winnerKey)!;

    for (const k of filingKeys) {
      if (k === winnerKey) continue;
      const loser = ranks.get(k)!;
      if (options.dropDuplicates) for (const idx of byFiling.get(k)!) dropped.add(idx);
      if (winner.amendment > loser.amendment) {
        const m = supersedes.get(winnerKey) ?? new Map<string, number>();
        m.set(k, (m.get(k) ?? 0) + 1);
        supersedes.set(winnerKey, m);
        supersededFilings.add(k);
      }
    }
  }

  const supersedesId = new Map<string, string>(); // winner filing key -> loser filing_id
  for (const [winnerKey, losers] of supersedes) {
    const best = [...losers.entries()].sort(
      (a, b) => b[1] - a[1] || compareRank(ranks.get(b[0])!, ranks.get(a[0])!),
    )[0]!;
    supersedesId.set(winnerKey, ranks.get(best[0])!.filing_id);
  }

  const out: Transaction[] = [];
  rows.forEach((t, i) => {
    if (dropped.has(i)) return;
    if ((t.parse_status !== 'ok' && t.parse_status !== 'ocr')) {
      out.push(t);
      return;
    }
    const fk = `${filerKeyOf(t)}|${t.filing_id}`;
    const sup = supersedesId.get(fk) ?? null;
    const isSuperseded = supersededFilings.has(fk);
    out.push(sup === null && !isSuperseded ? t : { ...t, supersedes_filing_id: sup, is_superseded: isSuperseded });
  });

  return {
    rows: out,
    duplicatesRemoved: dropped.size,
    supersessionsFound: supersedesId.size,
  };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

export function dedup(incoming: Transaction[], existing: Transaction[]): Transaction[] {
  const existingKeys = new Set(existing.map(dedupKey));
  return incoming.filter((t) => !existingKeys.has(dedupKey(t)));
}

// ─── Revision lookup ──────────────────────────────────────────────────────────
// Keyed by source_id (document + row ordinal), NOT by the dedup key or id —
// amount/date/asset are inputs to both of those, so a content revision on the
// same source_id produces a different dedup key and a different id by
// construction. This is the only way to recognize "the source revised this
// exact row" rather than seeing it as an unrelated new row.
//
// Last-write-wins per source_id: if a source_id has produced more than one
// prior row (successive revisions), the most recently fetched one is the
// correct baseline to diff the incoming row against.

export function latestBySourceId(existing: Transaction[]): Map<string, Transaction> {
  const map = new Map<string, Transaction>();
  for (const t of existing) {
    const prior = map.get(t.source_id);
    if (!prior || (t.fetchedAt ?? '') >= (prior.fetchedAt ?? '')) {
      map.set(t.source_id, t);
    }
  }
  return map;
}

// ─── Filing-level placeholder lookup ──────────────────────────────────────────
// Keyed by filing_id (the doc id shared by every row/placeholder from one
// filing), NOT source_id (which is per-row and therefore different for a
// placeholder — one row per filing — versus real transaction rows — one row
// per line item). This is what lets pipeline.ts's supersede step ask "does
// this filing currently have a stale placeholder in storage?" regardless of
// how many real rows it now produces.

export function placeholdersByFilingId(existing: Transaction[]): Map<string, Transaction> {
  const map = new Map<string, Transaction>();
  for (const t of existing) {
    if (t.parse_status === 'ok' || t.parse_status === 'ocr') continue;
    map.set(t.filing_id, t);
  }
  return map;
}

// ─── Legacy helper (kept for store/interface.ts compatibility) ────────────────

export function filterNewTrades(
  incoming: RawTransaction[],
  existingIds: Set<string>,
): RawTransaction[] {
  return incoming.filter((t) => !existingIds.has(t.source_id));
}
