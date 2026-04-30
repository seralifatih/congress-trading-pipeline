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
  raw_json: Record<string, unknown>;
}

// ─── Zod schema — single source of truth for Transaction shape ────────────────

export const TransactionSchema = z.object({
  id: z.string().uuid().optional(),
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
