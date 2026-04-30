import { SqliteStore } from '../src/store/sqliteStore.js';
import { generateId } from '../src/utils/dedup.js';
import type { Transaction } from '../src/types/index.js';

const TODAY = '2026-04-29';
const YESTERDAY = '2026-04-28';
const WEEK_AGO = '2026-04-22';
const MONTH_AGO = '2026-03-29';

const records: Omit<Transaction, 'id'>[] = [
  // Standard buys — common tickers
  { politician: 'Nancy Pelosi', transaction_date: TODAY, filing_date: TODAY, ticker: 'NVDA', asset_name: 'NVIDIA Corporation', asset_type: 'Stock', type: 'buy', amount_min: 1_000_001, amount_max: 5_000_000, owner: 'joint' },
  { politician: 'Nancy Pelosi', transaction_date: TODAY, filing_date: TODAY, ticker: 'AAPL', asset_name: 'Apple Inc.', asset_type: 'Stock', type: 'buy', amount_min: 500_001, amount_max: 1_000_000, owner: 'joint' },
  // Same-day multiple trades by same politician (distinct assets — keep both per CLAUDE.md)
  { politician: 'Tommy Tuberville', transaction_date: YESTERDAY, filing_date: TODAY, ticker: 'LMT', asset_name: 'Lockheed Martin Corp.', asset_type: 'Stock', type: 'buy', amount_min: 15_001, amount_max: 50_000, owner: 'self' },
  { politician: 'Tommy Tuberville', transaction_date: YESTERDAY, filing_date: TODAY, ticker: 'RTX', asset_name: 'RTX Corporation', asset_type: 'Stock', type: 'buy', amount_min: 15_001, amount_max: 50_000, owner: 'self' },
  // Spouse owner
  { politician: 'Dan Crenshaw', transaction_date: WEEK_AGO, filing_date: YESTERDAY, ticker: 'XOM', asset_name: 'Exxon Mobil Corp.', asset_type: 'Stock', type: 'buy', amount_min: 50_001, amount_max: 100_000, owner: 'spouse' },
  // Missing ticker (null)
  { politician: 'Mark Kelly', transaction_date: WEEK_AGO, filing_date: WEEK_AGO, ticker: null, asset_name: 'iShares MSCI Emerging Markets ETF', asset_type: 'ETF', type: 'buy', amount_min: 1_001, amount_max: 15_000, owner: 'self' },
  { politician: 'Mark Kelly', transaction_date: WEEK_AGO, filing_date: WEEK_AGO, ticker: null, asset_name: 'Vanguard Total Stock Market ETF', asset_type: 'ETF', type: 'buy', amount_min: 1_001, amount_max: 15_000, owner: 'self' },
  // Very large amounts
  { politician: 'Nancy Pelosi', transaction_date: MONTH_AGO, filing_date: WEEK_AGO, ticker: 'GOOGL', asset_name: 'Alphabet Inc. Cl A', asset_type: 'Stock', type: 'buy', amount_min: 5_000_001, amount_max: null, owner: 'joint' },
  // Sells
  { politician: 'Josh Gottheimer', transaction_date: WEEK_AGO, filing_date: YESTERDAY, ticker: 'AMZN', asset_name: 'Amazon.com Inc.', asset_type: 'Stock', type: 'sell', amount_min: 250_001, amount_max: 500_000, owner: 'self' },
  { politician: 'Josh Gottheimer', transaction_date: MONTH_AGO, filing_date: WEEK_AGO, ticker: 'MSFT', asset_name: 'Microsoft Corp.', asset_type: 'Stock', type: 'sell', amount_min: 100_001, amount_max: 250_000, owner: 'self' },
  // Child owner
  { politician: 'Ro Khanna', transaction_date: MONTH_AGO, filing_date: MONTH_AGO, ticker: 'TSLA', asset_name: 'Tesla Inc.', asset_type: 'Stock', type: 'buy', amount_min: 1_001, amount_max: 15_000, owner: 'child' },
  // Mutual funds / non-stock asset types
  { politician: 'Shelley Moore Capito', transaction_date: MONTH_AGO, filing_date: MONTH_AGO, ticker: null, asset_name: 'Fidelity 500 Index Fund', asset_type: 'Mutual Fund', type: 'buy', amount_min: 15_001, amount_max: 50_000, owner: 'joint' },
  // Very small amount (min bracket)
  { politician: 'Dean Phillips', transaction_date: YESTERDAY, filing_date: TODAY, ticker: 'JPM', asset_name: 'JPMorgan Chase & Co.', asset_type: 'Stock', type: 'buy', amount_min: 1_001, amount_max: 15_000, owner: 'self' },
  // Same ticker bought by two different politicians (cluster-like)
  { politician: 'Michael McCaul', transaction_date: YESTERDAY, filing_date: TODAY, ticker: 'NVDA', asset_name: 'NVIDIA Corporation', asset_type: 'Stock', type: 'buy', amount_min: 50_001, amount_max: 100_000, owner: 'self' },
  { politician: 'Marjorie Taylor Greene', transaction_date: YESTERDAY, filing_date: TODAY, ticker: 'NVDA', asset_name: 'NVIDIA Corporation', asset_type: 'Stock', type: 'buy', amount_min: 15_001, amount_max: 50_000, owner: 'self' },
  // Options
  { politician: 'Nancy Pelosi', transaction_date: WEEK_AGO, filing_date: YESTERDAY, ticker: 'AAPL', asset_name: 'Apple Inc. Call Option $200 exp 01/17/2025', asset_type: 'Stock Option', type: 'buy', amount_min: 500_001, amount_max: 1_000_000, owner: 'joint' },
  // Bond
  { politician: 'Bob Menendez', transaction_date: MONTH_AGO, filing_date: MONTH_AGO, ticker: null, asset_name: 'US Treasury Note 4.625% 2026', asset_type: 'US Treasury', type: 'buy', amount_min: 100_001, amount_max: 250_000, owner: 'self' },
  // Exact-value amount (min === max)
  { politician: 'Virginia Foxx', transaction_date: WEEK_AGO, filing_date: WEEK_AGO, ticker: 'CVS', asset_name: 'CVS Health Corp.', asset_type: 'Stock', type: 'buy', amount_min: 50_000, amount_max: 50_000, owner: 'self' },
  // Recent sell — AAPL (tests ticker filter with sell type)
  { politician: 'Suzan DelBene', transaction_date: TODAY, filing_date: TODAY, ticker: 'AAPL', asset_name: 'Apple Inc.', asset_type: 'Stock', type: 'sell', amount_min: 100_001, amount_max: 250_000, owner: 'joint' },
  // Old date near 90-day boundary
  { politician: 'Pete Sessions', transaction_date: '2026-01-31', filing_date: '2026-02-04', ticker: 'BAC', asset_name: 'Bank of America Corp.', asset_type: 'Stock', type: 'buy', amount_min: 15_001, amount_max: 50_000, owner: 'self' },
];

async function seed() {
  const store = SqliteStore.getInstance();
  const transactions: Transaction[] = records.map((r) => {
    const t = r as Transaction;
    return { ...t, id: generateId(t) };
  });

  await store.save(transactions);
  console.log(`Seeded ${transactions.length} transactions (INSERT OR IGNORE — dupes skipped)`);
  console.log(`DB total: ${store.count()}`);
  store.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
