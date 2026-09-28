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
  // Sourced from the filing's own label — null when the source doesn't say.
  // Never inferred from duplicate documents/rows.
  filing_type: 'original' | 'amendment' | null;
  amendment_number: number | null;
  // 'ok' unless this row is a placeholder for a filing submitted on paper
  // (Senate EFD serves it as a scanned image/PDF, not the structured HTML
  // table electronic PTRs get) — see fetcher/senateFetcher.ts
  // buildPaperPlaceholder. A placeholder row carries politician/filing_date/
  // source_id/pdf_url only; every transaction-detail field below is blank.
  parse_status: 'ok' | 'scanned_unparsed';
  pdf_url: string | null;
  raw_json: Record<string, unknown>;
}

// ─── Zod schema — single source of truth for Transaction shape ────────────────

export const TransactionSchema = z.object({
  id: z.string().optional(), // sha256 hex digest, not a UUID — see utils/dedup.ts
  politician: z.string().min(1),
  // Null only on a 'scanned_unparsed' placeholder row — see parse_status.
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').nullable(),
  filing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  ticker: z.string().nullable(),
  asset_name: z.string().min(1).nullable(),
  asset_type: z.string().min(1).nullable(),
  // Derived, not sourced: Senate's own asset_type checkbox set has no ETF/Fund
  // option, so filers commonly mark those as "Stock". Only set when asset_type
  // is "Stock" and asset_name matches an ETF/Fund pattern — null otherwise,
  // including for non-"Stock" types like "Other" or "Non-Public Stock", where
  // a name-text guess would be less reliable than the source's own label.
  // See transformer/normalize.ts deriveAssetSubtype.
  asset_subtype: z.enum(['ETF', 'Mutual Fund']).nullable(),
  type: z.enum(['buy', 'sell', 'exchange']).nullable(),
  // Not always an integer: a single exact-amount disclosure (as opposed to a
  // bracketed range) can report cents, e.g. "$2,722.50" — see the House
  // actor's DocID 20034999 for a confirmed real-world case — and
  // transformer/normalize.ts stripAmount.
  amount_min: z.number().nonnegative().nullable(),
  amount_max: z.number().nonnegative().nullable(),
  owner: z.enum(['self', 'joint', 'spouse', 'child']).nullable(),
  source_id: z.string().min(1),
  // sha256 of politician|transaction_date|asset_name|type|amount_min|amount_max|owner
  // (source_id deliberately excluded) — see utils/dedup.ts computeContentHash.
  // Rows sharing a content_hash within the same source document are legitimate
  // distinct tranches; rows sharing one across different documents are the
  // same real-world transaction reported twice. We never drop rows for this —
  // consumers decide. See README "Duplicate transactions across filings".
  content_hash: z.string(),
  // Sourced from the filing's own label ("(Amendment N)" on Senate, "Filing
  // Status: New/Amended" per row on House). Never inferred from duplication —
  // null when the source doesn't say.
  filing_type: z.enum(['original', 'amendment']).nullable(),
  // Senate only: the N in "(Amendment N)". No equivalent exists on House.
  amendment_number: z.number().int().positive().nullable().optional(),
  // 'scanned_unparsed': this filing was submitted on paper (Senate EFD serves
  // it at /search/view/paper/<id>/, a scanned image/PDF viewer, not the
  // structured HTML table electronic PTRs get at /search/view/ptr/<uuid>/) —
  // there is no OCR fallback, so the row is a placeholder: every
  // transaction-detail field below is null, and pdf_url points at the
  // filing's detail page so a human can go look. 'ok' for every normally-
  // parsed row. See fetcher/senateFetcher.ts buildPaperPlaceholder.
  parse_status: z.enum(['ok', 'scanned_unparsed']).default('ok'),
  // Populated only on a 'scanned_unparsed' placeholder row, where it points
  // at the paper filing's detail page (no per-row PDF exists — the whole
  // filing is one scanned document). Null on every normally-parsed row —
  // Senate's electronic PTR source is an HTML page, not a per-row PDF.
  pdf_url: z.string().nullable().optional(),
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
  // Filing-format counters for the run, from the listing's own link paths:
  //   electronicPtrCount   — /search/view/ptr/<uuid>/ (structured HTML table)
  //   paperCount           — /search/view/paper/<id>/ (scanned image/PDF)
  //   emptyPtrCount        — a /ptr/ link whose detail page had zero table
  //                          rows (parser/layout break, not a paper filing —
  //                          never turned into a placeholder, just counted)
  //   unknownDocTypeCount  — a listing row whose link matched NEITHER /ptr/
  //                          nor /paper/ (a new/changed Senate EFD link shape
  //                          this code doesn't recognize yet). Never silently
  //                          dropped — logged via log.warn as it's found and
  //                          counted here so a production run surfaces it.
  //   unknownDocTypeExamples — up to 5 example URLs from unknownDocTypeCount,
  //                            for diagnosing what the new shape looks like.
  electronicPtrCount: number;
  paperCount: number;
  emptyPtrCount: number;
  unknownDocTypeCount: number;
  unknownDocTypeExamples: string[];
}

// ─── Query filters for the store / API layer ─────────────────────────────────

export interface QueryFilters {
  politician?: string;
  ticker?: string;
  date_from?: string;  // YYYY-MM-DD inclusive
  date_to?: string;    // YYYY-MM-DD inclusive
  type?: 'buy' | 'sell' | 'exchange';
  owner?: 'self' | 'joint' | 'spouse' | 'child';
  parse_status?: 'ok' | 'scanned_unparsed';
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
