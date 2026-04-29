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
    transaction_date TEXT NOT NULL,
    filing_date     TEXT NOT NULL,
    ticker          TEXT,
    asset_name      TEXT NOT NULL,
    asset_type      TEXT,
    type            TEXT NOT NULL,
    amount_min      INTEGER,
    amount_max      INTEGER,
    owner           TEXT,
    inserted_at     TEXT DEFAULT (datetime('now'))
  )
`;

// ─── Row shape returned by better-sqlite3 ────────────────────────────────────

interface TransactionRow {
  id: string;
  politician: string;
  transaction_date: string;
  filing_date: string;
  ticker: string | null;
  asset_name: string;
  asset_type: string | null;
  type: string;
  amount_min: number | null;
  amount_max: number | null;
  owner: string | null;
  inserted_at: string;
}

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    politician: row.politician,
    transaction_date: row.transaction_date,
    filing_date: row.filing_date,
    ticker: row.ticker ?? null,
    asset_name: row.asset_name,
    asset_type: row.asset_type ?? '',
    type: row.type as Transaction['type'],
    amount_min: row.amount_min ?? 0,
    amount_max: row.amount_max ?? null,
    owner: (row.owner ?? 'self') as Transaction['owner'],
  };
}

// ─── SqliteStore ──────────────────────────────────────────────────────────────

export class SqliteStore implements StoreAdapter {
  private readonly db: Database.Database;

  private constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
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
        (id, politician, transaction_date, filing_date, ticker,
         asset_name, asset_type, type, amount_min, amount_max, owner)
      VALUES
        (@id, @politician, @transaction_date, @filing_date, @ticker,
         @asset_name, @asset_type, @type, @amount_min, @amount_max, @owner)
    `);

    const saveMany = this.db.transaction((rows: Transaction[]) => {
      let inserted = 0;
      for (const t of rows) {
        const id = t.id ?? generateId(t);
        const info = insert.run({
          id,
          politician: t.politician,
          transaction_date: t.transaction_date,
          filing_date: t.filing_date,
          ticker: t.ticker ?? null,
          asset_name: t.asset_name,
          asset_type: t.asset_type,
          type: t.type,
          amount_min: t.amount_min,
          amount_max: t.amount_max ?? null,
          owner: t.owner,
        });
        inserted += info.changes;
      }
      return inserted;
    });

    const inserted = saveMany(transactions);
    log.info(`save: ${inserted} inserted, ${transactions.length - inserted} already existed`);
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
