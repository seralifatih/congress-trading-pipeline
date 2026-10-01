import type { PipelineStats } from '../scheduler/pipeline.js';

// Written to the run's default key-value store under 'RUN_SUMMARY' on every
// successful run. `truncated: true` is the machine-readable signal that the
// dataset is missing rows because the run's max total charge was reached —
// the run itself still ends SUCCEEDED.
export function buildRunSummary(stats: PipelineStats): Record<string, unknown> {
  return {
    truncated: stats.truncated,
    reason: stats.truncated ? stats.truncationReason ?? 'max_total_charge_reached' : null,
    rowsEmitted: stats.rowsEmitted,
    rowsNotEmitted: stats.rowsNotEmitted,
    // Rows are emitted newest filing first, so a truncated run is missing the
    // OLDEST filings. lastFilingDate is the filing date of the last row
    // written; a filing straddling the cap may be only partly written, so
    // re-run with toDate = lastFilingDate (that day overlaps — see README)
    // and a higher max charge to pick up the rest.
    lastFilingDate: stats.lastFilingDate,
    lastFilingId: stats.lastFilingId,
    windowFrom: stats.windowFrom,
    windowTo: stats.windowTo,
    // Rows removed as exact cross-filing duplicates (same content_hash,
    // different filing) — before anything was written or billed.
    duplicatesCollapsed: stats.duplicatesRemoved,
    duplicatesRemoved: stats.duplicatesRemoved, // same value, kept for existing consumers
    skippedByMemberCount: stats.skippedByMemberCount,
    skippedByTransactionDateCount: stats.skippedByTransactionDateCount,
    filteredByTickerCount: stats.filteredByTickerCount,
    filteredByTransactionDateCount: stats.filteredByTransactionDateCount,
    // Placeholder rows (scanned_unparsed / parse_failed / fetch_failed) NOT
    // emitted because a tickers or transaction-date filter was set — their
    // content is unknown, so the filter can't be evaluated on them.
    placeholdersWithheld: stats.placeholdersExcludedCount,
    placeholdersExcludedCount: stats.placeholdersExcludedCount, // same value, kept for existing consumers
  };
}
