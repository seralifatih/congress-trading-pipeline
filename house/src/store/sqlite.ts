// SQLite implementation of StoreAdapter via better-sqlite3
// Schema mirrors the D1 tables in the frontend (raw_trades, signals, politicians)

import type { StoreAdapter } from './interface.js';

export class SqliteStore implements StoreAdapter {
  // TODO: implement
  upsertRawTrades: StoreAdapter['upsertRawTrades'] = async () => ({ ids: [], newCount: 0 });
  getExistingSourceIds: StoreAdapter['getExistingSourceIds'] = async () => new Set();
  insertSignals: StoreAdapter['insertSignals'] = async () => {};
  getAlreadyScoredIds: StoreAdapter['getAlreadyScoredIds'] = async () => new Set();
  markStaleSignals: StoreAdapter['markStaleSignals'] = async () => {};
  getFilerStats: StoreAdapter['getFilerStats'] = async () => null;
  getRecentSignals: StoreAdapter['getRecentSignals'] = async () => [];
  getSignalsByTicker: StoreAdapter['getSignalsByTicker'] = async () => [];
  getSignalsByFiler: StoreAdapter['getSignalsByFiler'] = async () => [];
  getSignalVolumeLast30Days: StoreAdapter['getSignalVolumeLast30Days'] = async () => [];
  getLastUpdated: StoreAdapter['getLastUpdated'] = async () => null;
}
