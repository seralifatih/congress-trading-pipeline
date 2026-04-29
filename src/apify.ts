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
    }>()) ?? {};

    log.info('Actor input', input);

    if (input.fetchDaysBack) process.env['FETCH_DAYS_BACK'] = String(input.fetchDaysBack);

    const store = ApifyStore.getInstance();
    const stats = await runPipeline(store, {
      fromDate: input.fromDate,
      toDate: input.toDate,
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
