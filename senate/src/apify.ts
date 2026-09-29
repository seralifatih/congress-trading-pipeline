import { Actor } from 'apify';
import { runPipeline } from './scheduler/pipeline.js';
import { ApifyStore } from './store/apifyStore.js';
import { makeLogger } from './utils/logger.js';
import { toErrorMessage } from './utils/errors.js';

const log = makeLogger('apify');

async function main(): Promise<void> {
  await Actor.init();

  try {
    const input = (await Actor.getInput<{
      fetchDaysBack?: number;
      fromDate?: string;
      toDate?: string;
      debugPtrLimit?: number;
    }>()) ?? {};

    log.info('Actor input', input);

    if (input.fetchDaysBack) process.env['FETCH_DAYS_BACK'] = String(input.fetchDaysBack);
    if (input.debugPtrLimit) process.env['DEBUG_PTR_LIMIT'] = String(input.debugPtrLimit);

    // Request proxy from the platform — gives a routable URL usable by axios.
    // Pass a stable sessionId so all requests share the SAME residential exit IP.
    // Django keeps prohibition_agreement state per-IP; rotating IPs invalidates
    // it and PTR pages redirect to home.
    const proxyConfig = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
    }).catch(() => null);

    const sessionId = `senate_${Date.now()}`;
    const proxyUrl = proxyConfig ? await proxyConfig.newUrl(sessionId) : undefined;
    if (proxyUrl) {
      log.info('Proxy acquired', {
        url: proxyUrl.replace(/:[^:@]+@/, ':***@'),
        sessionId,
      });
      process.env['APIFY_PROXY_URL'] = proxyUrl;
    } else {
      log.warn('No proxy available — requests will use direct connection');
    }

    const store = ApifyStore.getInstance();
    const stats = await runPipeline(store, {
      fromDate: input.fromDate,
      toDate: input.toDate,
    });

    log.info('Actor complete', stats);
    log.info(
      `Filing formats this run: electronic_ptr_count=${stats.electronicPtrCount}, ` +
      `paper_count=${stats.paperCount}, empty_ptr_count=${stats.emptyPtrCount}, ` +
      `fetch_failed_count=${stats.fetchFailedCount}, unknown_doc_type_count=${stats.unknownDocTypeCount}`,
    );
    if (stats.fetchFailedCount > 0) {
      log.warn(
        `${stats.fetchFailedCount} filing(s) produced a fetch_failed placeholder this run — ` +
        `the PTR detail-page fetch failed after retries (network/timeout/non-2xx), not a ` +
        `parser or format issue. Transient: a later run that successfully fetches the same ` +
        `filing automatically supersedes this placeholder. See dataset rows with parse_status="fetch_failed".`,
      );
    }
    if (stats.unknownDocTypeCount > 0) {
      log.warn(
        `${stats.unknownDocTypeCount} listing link(s) matched neither /ptr/ nor /paper/ — ` +
        `Senate EFD may have changed its link format. Examples: ${stats.unknownDocTypeExamples.join(', ')}`,
      );
    }
    // Written to the run's default key-value store under 'OUTPUT' — the
    // standard Apify convention, visible in the console without a separate
    // lookup. Includes electronicPtrCount/paperCount/emptyPtrCount/
    // fetchFailedCount/unknownDocTypeCount so the electronic-vs-paper ratio,
    // any transient fetch failures, and any new/unrecognized link shape can
    // be read back after any production run.
    await Actor.setValue('OUTPUT', stats);
  } catch (err) {
    log.error('Actor failed', { error: toErrorMessage(err) });
    await Actor.fail(toErrorMessage(err));
  }

  await Actor.exit();
}

main().catch((err) => {
  console.error('[apify] Fatal:', err);
  process.exit(1);
});
