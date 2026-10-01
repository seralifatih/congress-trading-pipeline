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
  // 0-based position of this row among the filing's parsed data rows, in
  // source order. Absent on rows from code paths that don't set it.
  row_index_in_filing?: number;
  // The filing's own doc id (House DocID), shared by EVERY row and
  // placeholder that came from this one filing — unlike source_id, which is
  // per-transaction-row (house_${docId}_${rowIndex}) and therefore different
  // for every row within the same filing. filing_id is what lets the
  // pipeline recognize "a fetch_failed placeholder and a later successful
  // parse are the SAME filing" and supersede the placeholder — see
  // utils/dedup.ts latestByFilingId and scheduler/pipeline.ts's supersede
  // step. Always equal to docId, never derived/hashed.
  filing_id: string;
  // Sourced from the PTR's own per-row "Filing Status: New/Amended" comment
  // line — null when the source doesn't say. Never inferred from duplication.
  filing_type: 'original' | 'amendment' | null;
  // 'ok' unless this row is a placeholder — see parseHousePtrText /
  // houseFetcher.ts:
  //   'fetch_failed'     — the PDF download itself failed after retries
  //     (network error, timeout, non-2xx, or a buffer pdf-parse couldn't
  //     read at all) — we never even got to look at the filing's content.
  //     Distinct from 'parse_failed': this is a transient fetch-layer
  //     failure, likely to succeed on a later run — see pipeline.ts's
  //     supersede step, which replaces this placeholder with real rows (or
  //     scanned_unparsed/parse_failed) once a fetch succeeds.
  //   'scanned_unparsed' — no [XX] markers found at all (scanned/paper PTR,
  //     no text layer). Either no OCR template recognizes this filing's page
  //     layout, or OCR was attempted and at least one row failed validation
  //     — see ocr/index.ts: an OCR filing is all-or-nothing, never partial.
  //   'parse_failed'     — markers WERE found (so the PDF has a text layer
  //     and isn't a scanned filing) but no transaction row matched — an
  //     unrecognized amount/date/type-code shape TX_RE doesn't handle yet
  //     (e.g. DocID 20034999's single-exact-amount-with-cents format before
  //     it was fixed). Distinct from 'scanned_unparsed' because it signals a
  //     parser gap, not a known source-format limitation.
  //   'ocr'              — recovered via OCR (see ocr/index.ts). Every row
  //     in the filing passed validation; see ocr_confidence for this row's
  //     score.
  // A placeholder row ('fetch_failed', 'scanned_unparsed', or
  // 'parse_failed') carries politician/filing_date/source_id/filing_id/
  // pdf_url only; every transaction-detail field below is empty/blank,
  // normalize.ts passes it straight through unvalidated. An 'ocr' row
  // carries full transaction-detail fields, same shape as 'ok'.
  parse_status: 'ok' | 'fetch_failed' | 'scanned_unparsed' | 'parse_failed' | 'ocr';
  pdf_url: string | null;
  // Per-row OCR confidence (0-100, tesseract.js's mean word confidence for
  // this row's crops), only set when parse_status === 'ocr'. Null otherwise.
  ocr_confidence: number | null;
  raw_json: Record<string, unknown>;
}

// ─── Zod schema — single source of truth for Transaction shape ────────────────

export const TransactionSchema = z.object({
  id: z.string().optional(), // sha256 hex digest, not a UUID — see utils/dedup.ts
  politician: z.string().min(1),
  // The filer name as the House index printed it (First Last Suffix), before
  // any normalization — e.g. "Scott Scott Franklin" (the source's own First
  // field is "Scott Scott"). Optional so rows from older versions validate.
  politician_raw: z.string().optional(),
  // unitedstates/congress-legislators bioguide id, resolved from the filer
  // name. Null when the name matches no current House member or more than
  // one — never guessed.
  member_bioguide_id: z.string().nullable().optional(),
  // Null only on a 'scanned_unparsed' placeholder row — see parse_status.
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').nullable(),
  filing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  ticker: z.string().nullable(),
  asset_name: z.string().min(1).nullable(),
  asset_type: z.string().min(1).nullable(),
  // Derived directly from the source PDF's own asset-type marker code (ET →
  // "ETF", MF → "Mutual Fund" — see ASSET_TYPE_MAP in housePdfParser.ts), so
  // unlike Senate this is a direct source signal, not a name-text guess. Null
  // for every other asset_type, and on a 'scanned_unparsed' placeholder row.
  // See transformer/normalize.ts deriveAssetSubtype.
  asset_subtype: z.enum(['ETF', 'Mutual Fund']).nullable(),
  type: z.enum(['buy', 'sell', 'exchange']).nullable(),
  // Not always an integer: a single exact-amount disclosure (as opposed to a
  // bracketed range) can report cents, e.g. "$2,722.50" (DocID 20034999) —
  // see transformer/normalize.ts stripAmount.
  amount_min: z.number().nonnegative().nullable(),
  amount_max: z.number().nonnegative().nullable(),
  owner: z.enum(['self', 'joint', 'spouse', 'child']).nullable(),
  source_id: z.string().min(1),
  // The filing's own doc id — see RawTransaction.filing_id above. Shared by
  // every row/placeholder from the same filing; used by pipeline.ts to
  // supersede a stale fetch_failed/scanned_unparsed/parse_failed placeholder
  // once a later run successfully parses that same filing.
  filing_id: z.string().min(1),
  // 'fetch_failed': the PDF download itself failed after retries (network
  // error, timeout, non-2xx, or an unreadable buffer) — content was never
  // examined. Transient by nature: pipeline.ts supersedes this placeholder
  // with real rows (or a scanned_unparsed/parse_failed placeholder) the
  // moment a later run's fetch succeeds for the same filing_id.
  // 'scanned_unparsed': this filing's PDF has no extractable text layer (a
  // scanned/paper PTR); either no OCR template recognizes this filing's page
  // layout, or OCR was attempted and at least one row failed validation (see
  // ocr/index.ts — an OCR filing is all-or-nothing, never partial).
  // 'parse_failed': the PDF DOES have a text layer and markers were found,
  // but no row matched TX_RE — a parser gap (unrecognized amount/date/
  // type-code shape), not a known source-format limitation.
  // 'fetch_failed'/'scanned_unparsed'/'parse_failed' are placeholders: every
  // transaction-detail field above is null, and pdf_url points at the source
  // PDF so a human (or a parser fix) can go look. 'ok' for every
  // normally-parsed row, on both Senate and House. 'ocr': recovered via OCR
  // (House only) — carries full transaction-detail fields like 'ok', plus
  // ocr_confidence below.
  parse_status: z.enum(['ok', 'fetch_failed', 'scanned_unparsed', 'parse_failed', 'ocr']),
  // Source PDF URL. Populated on House rows (scanned or not); null on
  // Senate, which has no per-row PDF (its source is HTML).
  pdf_url: z.string().nullable().optional(),
  // Per-row OCR confidence (0-100). Set only when parse_status === 'ocr';
  // null for every other row (including on Senate, which never uses OCR).
  ocr_confidence: z.number().min(0).max(100).nullable().optional(),
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
  // Always null on House — schema parity with Senate's "(Amendment N)" label,
  // which has no House-source equivalent (see filing_type above).
  amendment_number: z.number().int().positive().nullable().optional(),
  // Set on an amended row's filing when an earlier filing by the same filer
  // shares at least one identical trade with it (same content_hash) — the only
  // evidence of supersession the source exposes (no explicit link). The id of
  // that earlier filing; null when not determinable.
  // 0-based position of the row among its filing's parsed data rows, in source
  // order — tells apart repeated line items inside one filing (which share a
  // content_hash). Not part of id or content_hash. 0 on a placeholder (a
  // filing's only row). Null when the producing code path couldn't provide it.
  row_index_in_filing: z.number().int().nonnegative().nullable().optional(),
  supersedes_filing_id: z.string().nullable().optional(),
  // True on the surviving rows of a filing that a later amended filing
  // supersedes by the rule above. False otherwise.
  is_superseded: z.boolean().optional(),
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
  // Count of filings that produced a 'fetch_failed' placeholder this run —
  // the PDF download failed after retries, so the filing's content was
  // never even examined. See houseFetcher.ts's fetch catch block / types/
  // index.ts parse_status. Surfaced so a transient network/host failure
  // shows up in run stats instead of the filing silently vanishing.
  fetchFailedCount: number;
  // Count of filings that produced a 'parse_failed' placeholder this run —
  // markers found (so not a scanned/paper PTR) but no row matched TX_RE.
  // Surfaced so a parser gap shows up in run stats instead of silently
  // vanishing. See parseHousePtrText / types/index.ts parse_status.
  parseFailedCount: number;
  // Count of scanned filings whose page layout matched a known OCR template
  // and produced parse_status "ocr" rows this run (every row in the filing
  // passed validation — see ocr/index.ts). Does NOT count scanned filings
  // that stayed "scanned_unparsed" (unrecognized template, or OCR attempted
  // but a row failed validation).
  ocrFilingCount: number;
  // Total "ocr" rows produced this run, across all ocrFilingCount filings.
  ocrRowCount: number;
  // Filings skipped at the PTR index level — before their PDF was
  // downloaded — because they could not match the members /
  // transactionDateFrom inputs. Absent when no such filter was set.
  skippedByMemberCount?: number;
  skippedByTransactionDateCount?: number;
}

// ─── Query filters for the store / API layer ─────────────────────────────────

export interface QueryFilters {
  politician?: string;
  ticker?: string;
  date_from?: string;  // YYYY-MM-DD inclusive
  date_to?: string;    // YYYY-MM-DD inclusive
  type?: 'buy' | 'sell' | 'exchange';
  owner?: 'self' | 'joint' | 'spouse' | 'child';
  parse_status?: 'ok' | 'fetch_failed' | 'scanned_unparsed' | 'parse_failed' | 'ocr';
  limit?: number;
  offset?: number;
}

// ─── Storage adapter interface ────────────────────────────────────────────────

// Returned by a store whose save() can stop short — ApifyStore, when the
// run's max total charge is reached. A store with no cap (SqliteStore) may
// return void; the pipeline then treats everything as saved.
export interface SaveResult {
  saved: number;
  truncated: boolean;
  reason?: 'max_total_charge_reached';
  notSaved: number;
}

export interface StoreAdapter {
  save(transactions: Transaction[]): Promise<SaveResult | void>;
  query(filters?: QueryFilters): Promise<Transaction[]>;
  // Removes stale placeholder rows for the given filing_ids — called by
  // pipeline.ts's supersede step when a filing that previously produced a
  // fetch_failed/scanned_unparsed/parse_failed placeholder is superseded by
  // real (parse_status "ok"/"ocr") rows in this run. SqliteStore actually
  // deletes (it's a rebuildable local cache); ApifyStore's underlying
  // Dataset has no delete API, so it logs and no-ops — the old placeholder
  // physically remains in the dataset, which is a real, documented
  // limitation (see house/README.md Coverage section) rather than something
  // silently swept under the rug.
  deleteByFilingIds(filingIds: string[]): Promise<void>;
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
