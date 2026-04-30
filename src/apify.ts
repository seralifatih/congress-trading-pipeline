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
      includeSenate?: boolean;
      includeHouse?: boolean;
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
      includeSenate: input.includeSenate,
      includeHouse: input.includeHouse,
    });

    log.info('Actor complete', stats);
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
