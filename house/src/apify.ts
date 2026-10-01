import { Actor } from 'apify';
import { runPipeline } from './scheduler/pipeline.js';
import { ApifyStore } from './store/apifyStore.js';
import { parseInput, toPipelineOptions, type ActorInput } from './utils/input.js';
import { buildRunSummary } from './utils/runSummary.js';
import { makeLogger } from './utils/logger.js';
import { toErrorMessage } from './utils/errors.js';

const log = makeLogger('apify-house');

async function main(): Promise<void> {
  await Actor.init();

  try {
    const rawInput = (await Actor.getInput<ActorInput>()) ?? {};

    log.info('Actor input', rawInput);

    // Validated and passed to the pipeline explicitly. fetchDaysBack,
    // debugPtrLimit and enableOcr used to be written to process.env here, but
    // that ran AFTER config.ts had already read process.env at import time,
    // so they were silently ignored (every run used the 90-day default).
    const input = parseInput(rawInput);

    // DEBUG_PDF_TEXT is read from process.env at call time inside the parser,
    // so setting it here still works.
    if (input.debugPdfText) process.env['DEBUG_PDF_TEXT'] = '1';

    // House data comes straight from disclosures-clerk.house.gov over plain HTTPS.
    // No Akamai, no terms acceptance — proxy is optional. Skip it to save quota.

    const store = ApifyStore.getInstance();
    // OCR prototype, off by default — see config.ts's ENABLE_OCR and
    // src/ocr/README.md for why.
    const stats = await runPipeline(store, toPipelineOptions(input));

    log.info('Actor complete', stats);
    if (stats.fetchFailedCount > 0) {
      log.warn(
        `${stats.fetchFailedCount} filing(s) produced a fetch_failed placeholder this run — ` +
        `the PDF download failed after retries (network/timeout/non-2xx), not a parser or ` +
        `format issue. Transient: a later run that successfully fetches the same filing ` +
        `automatically supersedes this placeholder. See dataset rows with parse_status="fetch_failed".`,
      );
    }
    if (stats.parseFailedCount > 0) {
      log.warn(
        `${stats.parseFailedCount} filing(s) produced a parse_failed placeholder this run — ` +
        `markers found but no row matched TX_RE (a parser gap, not a scanned filing). See dataset rows with parse_status="parse_failed".`,
      );
    }
    if (stats.ocrFilingCount > 0) {
      log.info(
        `${stats.ocrFilingCount} filing(s) recovered via OCR this run (${stats.ocrRowCount} rows) — ` +
        `see dataset rows with parse_status="ocr".`,
      );
    }
    if (stats.truncated) {
      const message =
        `TRUNCATED: the run's maximum total charge was reached — ${stats.rowsEmitted} row(s) written, ` +
        `${stats.rowsNotEmitted} NOT written (oldest filings; last emitted filing date ${stats.lastFilingDate ?? 'n/a'}). ` +
        `Increase the maximum charge per run to get the full window. See RUN_SUMMARY.`;
      log.warn(message);
      await Actor.setStatusMessage(message).catch(() => undefined);
    }
    // Written to the run's default key-value store under 'OUTPUT' — the
    // standard Apify convention, visible in the console without a separate
    // lookup. Includes fetchFailedCount/parseFailedCount/ocrFilingCount/
    // ocrRowCount so a transient fetch failure, a parser gap, or an OCR
    // recovery surfaces in run stats instead of silently vanishing.
    await Actor.setValue('OUTPUT', stats);
    await Actor.setValue('RUN_SUMMARY', buildRunSummary(stats));
  } catch (err) {
    log.error('Actor failed', { error: toErrorMessage(err) });
    await Actor.fail(toErrorMessage(err));
  }

  await Actor.exit();
}

main().catch((err) => {
  console.error('[apify-house] Fatal:', err);
  process.exit(1);
});
