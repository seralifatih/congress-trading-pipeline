import { z } from 'zod';

// ─── Raw transaction as parsed from the Senate EFD response ──────────────────
// All fields are strings — no coercion at this stage.

export interface RawTransaction {
  politician: string;
  transaction_date: string;
  filing_date: string;
  ticker: string;
  asset_name: string;
  asset_type: string;
  type: string;
  amount: string;
  owner: string;
  source_id: string;
  // Sourced from the PTR's own per-row "Filing Status: New/Amended" comment
  // line — null when the source doesn't say. Never inferred from duplication.
  filing_type: 'original' | 'amendment' | null;
  raw_json: Record<string, unknown>;
}

// ─── Zod schema — single source of truth for Transaction shape ────────────────

export const TransactionSchema = z.object({
  id: z.string().optional(), // sha256 hex digest, not a UUID — see utils/dedup.ts
  politician: z.string().min(1),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  filing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  ticker: z.string().nullable(),
  asset_name: z.string().min(1),
  asset_type: z.string().min(1),
  type: z.enum(['buy', 'sell']),
  amount_min: z.number().int().nonnegative(),
  amount_max: z.number().int().nonnegative().nullable(),
  owner: z.enum(['self', 'joint', 'spouse', 'child']),
  source_id: z.string().min(1),
  // sha256 of politician|transaction_date|asset_name|type|amount_min|amount_max|owner
  // (source_id deliberately excluded) — see utils/dedup.ts computeContentHash.
  // Rows sharing a content_hash within the same source document are legitimate
  // distinct tranches; rows sharing one across different documents are the
  // same real-world transaction reported twice. We never drop rows for this —
  // consumers decide. See README "Duplicate transactions across filings".
  content_hash: z.string(),
  // Sourced from the PTR's own per-row "Filing Status: New/Amended" comment
  // line. Never inferred from duplication — null when the source doesn't say.
  // No amendment-number equivalent exists in the House source (unlike Senate).
  filing_type: z.enum(['original', 'amendment']).nullable(),
  // ISO 8601 UTC timestamp — when this row (this exact id) was first pulled
  // from source. Set once at insert and never touched again; a re-fetch of
  // an unchanged row is dropped by dedup() before it would overwrite this.
  // If a same-source_id row later changes content (a revision), the new
  // row gets a new id (amount/date/asset feed id's hash) but carries this
  // timestamp forward from the prior source_id match — see lastModifiedAt.
  fetchedAt: z.string(),
  // ISO 8601 UTC timestamp — when this row's content was last observed to
  // change. Equals fetchedAt for a first-seen row; bumped to "now" only when
  // a same-source_id row's content_hash differs from the prior one.
  lastModifiedAt: z.string(),
  // Count of detected content revisions for this source_id lineage. 0 for
  // first-seen; incremented each time a same-source_id row's content_hash
  // differs from the immediately prior one. See utils/dedup.ts.
  revisionCount: z.number().int().nonnegative(),
  created_at: z.string().optional(),
});

// Inferred type — always use this, never a separate hand-written interface.
export type Transaction = z.infer<typeof TransactionSchema>;

// ─── Fetch result returned by the fetcher layer ───────────────────────────────

export interface FetchResult {
  success: boolean;
  records: RawTransaction[];
  error?: string;
}

// ─── Query filters for the store / API layer ─────────────────────────────────

export interface QueryFilters {
  politician?: string;
  ticker?: string;
  date_from?: string;  // YYYY-MM-DD inclusive
  date_to?: string;    // YYYY-MM-DD inclusive
  type?: 'buy' | 'sell';
  owner?: 'self' | 'joint' | 'spouse' | 'child';
  limit?: number;
  offset?: number;
}

// ─── Storage adapter interface ────────────────────────────────────────────────

export interface StoreAdapter {
  save(transactions: Transaction[]): Promise<void>;
  query(filters?: QueryFilters): Promise<Transaction[]>;
}

// ─── Pipeline internals (kept from scaffold) ──────────────────────────────────

export interface ScoreBreakdown {
  size_score: number;          // 0-20
  delay_score: number;         // 0-15
  cluster_score: number;       // 0-25
  filer_track_record: number;  // 0-20
  relevance_score: number;     // 0-10
  recency_score: number;       // 0-10
}

export interface ClusterResult {
  ticker: string;
  trades: RawTransaction[];
  cluster_id: string;
  cluster_strength: number;
}

export interface Signal {
  id?: string;
  raw_trade_id: string;
  ticker: string;
  company_name: string | null;
  filer_name: string;
  filer_type: 'congress' | 'corporate_insider';
  party: 'D' | 'R' | 'I' | null;
  trade_type: 'purchase' | 'sale' | 'exchange';
  amount_low: number | null;
  amount_high: number | null;
  amount_midpoint: number | null;
  trade_date: string;
  filing_date: string;
  filing_delay_days: number;
  score: number;
  score_breakdown: ScoreBreakdown;
  filters_passed: string[];
  cluster_id: string | null;
  committees: string[] | null;
  is_active: boolean;
  created_at?: string;
}

export interface FilerStats {
  hit_rate: number;
  total_trades: number;
}

export interface PipelineSummary {
  ingested: number;
  newTrades: number;
  signalsGenerated: number;
  topScore: number | null;
  topScoreTicker: string | null;
  runAt: string;
}

export interface FilterResult {
  passed: RawTransaction[];
  clusters: ClusterResult[];
  rejected: number;
}
