import { Actor } from 'apify';
import { runPipeline } from './scheduler/pipeline.js';
import { ApifyStore } from './store/apifyStore.js';
import { makeLogger } from './utils/logger.js';
import { toErrorMessage } from './utils/errors.js';

const log = makeLogger('apify-house');

async function main(): Promise<void> {
  await Actor.init();

  try {
    const input = (await Actor.getInput<{
      fetchDaysBack?: number;
      fromDate?: string;
      toDate?: string;
    }>()) ?? {};

    log.info('Actor input', input);

    if (input.fetchDaysBack) process.env['FETCH_DAYS_BACK'] = String(input.fetchDaysBack);

    // House data comes straight from disclosures-clerk.house.gov over plain HTTPS.
    // No Akamai, no terms acceptance — proxy is optional. Skip it to save quota.

    const store = ApifyStore.getInstance();
    const stats = await runPipeline(store, {
      fromDate: input.fromDate,
      toDate: input.toDate,
      includeSenate: false,
      includeHouse: true,
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
  console.error('[apify-house] Fatal:', err);
  process.exit(1);
});
