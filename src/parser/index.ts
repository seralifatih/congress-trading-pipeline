import type { RawTransaction } from '../types/index.js';
import { parseHtml } from './htmlParser.js';
import { parseJsonHits, parseJsonSource } from './jsonParser.js';
import { makeLogger } from '../utils/logger.js';

export { parseHtml } from './htmlParser.js';
export { parseJsonHits, parseJsonSource } from './jsonParser.js';

const log = makeLogger('parser');

// ─── Unified entry point ──────────────────────────────────────────────────────

export function parse(input: unknown, format: 'json' | 'html'): RawTransaction[] {
  if (format === 'html') {
    if (typeof input !== 'string') {
      log.warn('parse(html) received non-string input — returning []');
      return [];
    }
    return parseHtml(input);
  }

  // format === 'json'
  // Accept either:
  //   - an array of Elasticsearch hits ({ _id, _source }[])
  //   - a single _source object
  if (Array.isArray(input)) {
    return parseJsonHits(input);
  }

  if (input !== null && typeof input === 'object') {
    return [parseJsonSource(input as Record<string, unknown>)];
  }

  log.warn('parse(json) received unexpected input type — returning []');
  return [];
}
