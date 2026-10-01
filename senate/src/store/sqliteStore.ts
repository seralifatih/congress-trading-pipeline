import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Transaction, QueryFilters, StoreAdapter } from '../types/index.js';
import { generateId } from '../utils/dedup.js';
import { makeLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';

const log = makeLogger('sqliteStore');

const DB_PATH = config.DB_PATH;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS transactions (
    id              TEXT PRIMARY KEY,
    politician      TEXT NOT NULL,
    politician_raw  TEXT,
    member_bioguide_id TEXT,
    transaction_date TEXT,
    filing_date     TEXT NOT NULL,
    ticker          TEXT,
    asset_name      TEXT,
    received_ticker TEXT,
    received_asset_name TEXT,
    asset_type      TEXT,
    asset_subtype   TEXT,
    type            TEXT,
    amount_min      REAL,
    amount_max      REAL,
    owner           TEXT,
    source_id       TEXT NOT NULL,
    filing_id       TEXT NOT NULL DEFAULT '',
    content_hash    TEXT NOT NULL,
    filing_type     TEXT,
    amendment_number INTEGER,
    row_index_in_filing INTEGER,
    supersedes_filing_id TEXT,
    is_superseded   INTEGER NOT NULL DEFAULT 0,
    parse_status    TEXT NOT NULL DEFAULT 'ok',
    pdf_url         TEXT,
    fetchedAt       TEXT NOT NULL,
    lastModifiedAt  TEXT NOT NULL,
    revisionCount   INTEGER NOT NULL DEFAULT 0,
    inserted_at     TEXT DEFAULT (datetime('now'))
  )
`;

// ─── Row shape returned by better-sqlite3 ────────────────────────────────────

interface TransactionRow {
  id: string;
  politician: string;
  politician_raw: string | null;
  member_bioguide_id: string | null;
  transaction_date: string | null;
  filing_date: string;
  ticker: string | null;
  asset_name: string | null;
  received_ticker: string | null;
  received_asset_name: string | null;
  asset_type: string | null;
  asset_subtype: string | null;
  type: string | null;
  amount_min: number | null;
  amount_max: number | null;
  owner: string | null;
  source_id: string | null;
  filing_id: string | null;
  content_hash: string | null;
  filing_type: string | null;
  amendment_number: number | null;
  row_index_in_filing: number | null;
  supersedes_filing_id: string | null;
  is_superseded: number | null;
  parse_status: string;
  pdf_url: string | null;
  fetchedAt: string;
  lastModifiedAt: string;
  revisionCount: number;
  inserted_at: string;
}

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    politician: row.politician,
    politician_raw: row.politician_raw ?? row.politician,
    member_bioguide_id: row.member_bioguide_id ?? null,
    transaction_date: row.transaction_date,
    filing_date: row.filing_date,
    ticker: row.ticker ?? null,
    asset_name: row.asset_name,
    received_ticker: row.received_ticker ?? null,
    received_asset_name: row.received_asset_name ?? null,
    asset_type: row.asset_type,
    asset_subtype: row.asset_subtype as Transaction['asset_subtype'],
    type: row.type as Transaction['type'],
    amount_min: row.amount_min,
    amount_max: row.amount_max ?? null,
    owner: row.owner as Transaction['owner'],
    source_id: row.source_id ?? '',
    filing_id: row.filing_id ?? '',
    content_hash: row.content_hash ?? '',
    filing_type: row.filing_type as Transaction['filing_type'],
    amendment_number: row.amendment_number,
    row_index_in_filing: row.row_index_in_filing ?? null,
    supersedes_filing_id: row.supersedes_filing_id ?? null,
    is_superseded: row.is_superseded === 1,
    parse_status: (row.parse_status as Transaction['parse_status']) ?? 'ok',
    pdf_url: row.pdf_url ?? null,
    fetchedAt: row.fetchedAt,
    lastModifiedAt: row.lastModifiedAt,
    revisionCount: row.revisionCount ?? 0,
  };
}

// ─── Schema migration ─────────────────────────────────────────────────────────
// SqliteStore is a local, rebuildable dedup cache (not the customer-facing
// output — that's ApifyStore/Dataset), so an outdated database is simply
// stale, not something to preserve. Detect an old schema (table exists but is
// missing a column the current INSERT/SELECT bindings require) and drop it so
// CREATE_TABLE below recreates it with the current shape. Runs automatically
// on every connect — no manual step.

const REQUIRED_COLUMNS = [
  'source_id', 'filing_id', 'content_hash', 'filing_type', 'amendment_number', 'asset_subtype',
  'parse_status', 'pdf_url', 'fetchedAt', 'lastModifiedAt', 'revisionCount',
  'politician_raw', 'member_bioguide_id', 'supersedes_filing_id', 'is_superseded',
  'received_ticker', 'received_asset_name', 'row_index_in_filing',
];

function migrateIfNeeded(db: Database.Database): void {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transactions'`)
    .get();
  if (!tableExists) return;

  const columns = db.prepare(`PRAGMA table_info(transactions)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));
  const missing = REQUIRED_COLUMNS.filter((c) => !columnNames.has(c));
  if (missing.length === 0) return;

  const { n } = db.prepare('SELECT COUNT(*) as n FROM transactions').get() as { n: number };
  log.warn(
    `Outdated schema detected (missing: ${missing.join(', ')}) — dropping and rebuilding ` +
    `'transactions' table (${n} stale row(s) discarded; this store is a rebuildable dedup ` +
    `cache, re-ingested from source on the next pipeline run)`,
  );
  db.exec('DROP TABLE transactions');
}

// ─── SqliteStore ──────────────────────────────────────────────────────────────

export class SqliteStore implements StoreAdapter {
  private readonly db: Database.Database;

  private constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    migrateIfNeeded(this.db);
    this.db.exec(CREATE_TABLE);
    log.info(`Connected to ${dbPath}`);
  }

  // ─── Singleton ──────────────────────────────────────────────────────────────

  private static instance: SqliteStore | null = null;

  static getInstance(dbPath: string = DB_PATH): SqliteStore {
    if (!SqliteStore.instance) {
      SqliteStore.instance = new SqliteStore(dbPath);
    }
    return SqliteStore.instance;
  }

  // ─── StoreAdapter: save ──────────────────────────────────────────────────────

  async save(transactions: Transaction[]): Promise<void> {
    if (transactions.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO transactions
        (id, politician, politician_raw, member_bioguide_id, transaction_date, filing_date, ticker,
         asset_name, received_ticker, received_asset_name, asset_type, asset_subtype, type, amount_min, amount_max, owner, source_id, filing_id,
         content_hash, filing_type, amendment_number, row_index_in_filing, supersedes_filing_id, is_superseded, parse_status, pdf_url,
         fetchedAt, lastModifiedAt, revisionCount)
      VALUES
        (@id, @politician, @politician_raw, @member_bioguide_id, @transaction_date, @filing_date, @ticker,
         @asset_name, @received_ticker, @received_asset_name, @asset_type, @asset_subtype, @type, @amount_min, @amount_max, @owner, @source_id, @filing_id,
         @content_hash, @filing_type, @amendment_number, @row_index_in_filing, @supersedes_filing_id, @is_superseded, @parse_status, @pdf_url,
         @fetchedAt, @lastModifiedAt, @revisionCount)
    `);

    const saveMany = this.db.transaction((rows: Transaction[]) => {
      let inserted = 0;
      for (const t of rows) {
        const id = t.id ?? generateId(t);
        const info = insert.run({
          id,
          politician: t.politician,
          politician_raw: t.politician_raw ?? null,
          member_bioguide_id: t.member_bioguide_id ?? null,
          transaction_date: t.transaction_date,
          filing_date: t.filing_date,
          ticker: t.ticker ?? null,
          asset_name: t.asset_name,
          received_ticker: t.received_ticker ?? null,
          received_asset_name: t.received_asset_name ?? null,
          asset_type: t.asset_type,
          asset_subtype: t.asset_subtype ?? null,
          type: t.type,
          amount_min: t.amount_min,
          amount_max: t.amount_max ?? null,
          owner: t.owner,
          source_id: t.source_id,
          filing_id: t.filing_id,
          content_hash: t.content_hash,
          filing_type: t.filing_type ?? null,
          amendment_number: t.amendment_number ?? null,
          row_index_in_filing: t.row_index_in_filing ?? null,
          supersedes_filing_id: t.supersedes_filing_id ?? null,
          is_superseded: t.is_superseded ? 1 : 0,
          parse_status: t.parse_status,
          pdf_url: t.pdf_url ?? null,
          fetchedAt: t.fetchedAt,
          lastModifiedAt: t.lastModifiedAt,
          revisionCount: t.revisionCount,
        });
        inserted += info.changes;
      }
      return inserted;
    });

    const inserted = saveMany(transactions);
    log.info(`save: ${inserted} inserted, ${transactions.length - inserted} already existed`);
  }

  // ─── StoreAdapter: deleteByFilingIds ─────────────────────────────────────────
  // Deletes only the PLACEHOLDER rows (fetch_failed/scanned_unparsed/
  // parse_failed) whose filing_id is in the given list — used by
  // pipeline.ts's supersede step to remove a stale placeholder once a later
  // run produces real rows for the same filing. Deliberately scoped to
  // placeholder parse_status values, NOT "every row with this filing_id":
  // by the time this runs, the real ("ok") rows for the same filing_id have
  // already been saved in this same pipeline run (save() happens before
  // deleteByFilingIds() — see pipeline.ts), and a filing_id-only WHERE
  // clause would delete those too, corrupting the very data this mechanism
  // exists to protect.

  async deleteByFilingIds(filingIds: string[]): Promise<void> {
    if (filingIds.length === 0) return;

    const filingPlaceholders = filingIds.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `DELETE FROM transactions WHERE filing_id IN (${filingPlaceholders}) ` +
      `AND parse_status IN ('fetch_failed', 'scanned_unparsed', 'parse_failed')`,
    );
    const info = stmt.run(...filingIds);
    log.info(`deleteByFilingIds: removed ${info.changes} stale placeholder row(s) for ${filingIds.length} filing(s)`);
  }

  // ─── StoreAdapter: query ─────────────────────────────────────────────────────

  async query(filters: QueryFilters = {}): Promise<Transaction[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.politician) {
      conditions.push('politician LIKE @politician');
      params['politician'] = `%${filters.politician}%`;
    }
    if (filters.ticker) {
      conditions.push('ticker = @ticker');
      params['ticker'] = filters.ticker.toUpperCase();
    }
    if (filters.type) {
      conditions.push('type = @type');
      params['type'] = filters.type;
    }
    if (filters.owner) {
      conditions.push('owner = @owner');
      params['owner'] = filters.owner;
    }
    if (filters.parse_status) {
      conditions.push('parse_status = @parse_status');
      params['parse_status'] = filters.parse_status;
    }
    if (filters.date_from) {
      conditions.push('transaction_date >= @date_from');
      params['date_from'] = filters.date_from;
    }
    if (filters.date_to) {
      conditions.push('transaction_date <= @date_to');
      params['date_to'] = filters.date_to;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 500;
    const offset = filters.offset ?? 0;

    const sql = `
      SELECT * FROM transactions
      ${where}
      ORDER BY transaction_date DESC, inserted_at DESC
      LIMIT @limit OFFSET @offset
    `;

    const rows = this.db
      .prepare(sql)
      .all({ ...params, limit, offset }) as TransactionRow[];

    return rows.map(rowToTransaction);
  }

  // ─── Extra: count ────────────────────────────────────────────────────────────

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM transactions')
      .get() as { n: number };
    return row.n;
  }

  // ─── Extra: close (useful in tests) ─────────────────────────────────────────

  close(): void {
    this.db.close();
    SqliteStore.instance = null;
  }
}
