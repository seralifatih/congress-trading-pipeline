import { makeLogger } from './logger.js';

const log = makeLogger('retry');

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delayMs: number = 500,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;

      // Exponential backoff with ±25% jitter
      const base = delayMs * 2 ** attempt;
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      const wait = Math.round(base + jitter);

      log.warn(`Attempt ${attempt + 1}/${retries + 1} failed — retrying in ${wait}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });

      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  throw lastErr;
}
