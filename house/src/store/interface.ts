import type { RawTransaction, Signal, FilerStats } from '../types/index.js';

// Storage adapter — all DB implementations must satisfy this interface

export interface StoreAdapter {
  // Raw trades
  upsertRawTrades(trades: RawTransaction[]): Promise<{ ids: string[]; newCount: number }>;
  getExistingSourceIds(source: RawTransaction['source_id']): Promise<Set<string>>;

  // Signals
  insertSignals(signals: Signal[]): Promise<void>;
  getAlreadyScoredIds(rawTradeIds: string[]): Promise<Set<string>>;
  markStaleSignals(olderThanDays: number): Promise<void>;

  // Filer stats (for scoring)
  getFilerStats(name: string, filerType: Signal['filer_type']): Promise<FilerStats | null>;

  // Read — consumed by Express API routes
  getRecentSignals(limit: number, minScore?: number): Promise<Signal[]>;
  getSignalsByTicker(ticker: string): Promise<Signal[]>;
  getSignalsByFiler(filerName: string): Promise<Signal[]>;
  getSignalVolumeLast30Days(): Promise<Array<{ date: string; count: number }>>;
  getLastUpdated(): Promise<string | null>;
}
