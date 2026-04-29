import axios, { AxiosError } from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { format, subDays } from 'date-fns';
import type { FetchResult, RawTransaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { withRetry } from '../utils/retry.js';

const log = makeLogger('senateFetcher');

const BASE_URL = 'https://efts.senate.gov/LATEST/search-index';
const PAGE_SIZE = 100;
const TIMEOUT_MS = 10_000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://efts.senate.gov/LATEST/search-index',
};

// ─── Apify Proxy ──────────────────────────────────────────────────────────────
// When running on Apify platform, APIFY_PROXY_PASSWORD is injected automatically.
// Route through residential proxy to avoid datacenter IP blocks on government sites.

function getProxyConfig(): AxiosRequestConfig['proxy'] | undefined {
  const password = process.env['APIFY_PROXY_PASSWORD'];
  if (!password) return undefined;

  log.info('Routing via Apify Proxy (residential)');
  return {
    host: 'proxy.apify.com',
    port: 8000,
    auth: { username: 'groups-RESIDENTIAL', password },
  };
}

// ─── Response shapes (internal — not exported) ────────────────────────────────

interface EfdSource {
  // Filer
  first_name?: string;
  last_name?: string;
  senator_name?: string;
  // Filing metadata
  date_filed?: string;
  filing_date?: string;
  report_id?: string;
  // Transaction fields (present on PTR line-items)
  transaction_date?: string;
  ticker?: string;
  asset_name?: string;
  asset_type?: string;
  transaction_type?: string;
  amount?: string;
  owner?: string;
  [key: string]: unknown;
}

interface EfdHit {
  _id: string;
  _source: EfdSource;
}

interface EfdResponse {
  hits: {
    total: { value: number } | number;
    hits: EfdHit[];
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoToday(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

function isoDefaultStart(): string {
  return format(subDays(new Date(), config.FETCH_DAYS_BACK), 'yyyy-MM-dd');
}

function totalCount(response: EfdResponse): number {
  const t = response.hits.total;
  return typeof t === 'number' ? t : t.value;
}

function buildUrl(fromDate: string, toDate: string, offset: number): string {
  const params = new URLSearchParams({
    q: '""',
    dateRange: 'custom',
    fromDate,
    toDate,
    results: String(PAGE_SIZE),
    start: String(offset),
  });
  return `${BASE_URL}?${params.toString()}`;
}

function resolveName(src: EfdSource): string {
  if (src.senator_name) return src.senator_name.trim();
  const parts = [src.first_name, src.last_name].filter(Boolean);
  if (parts.length > 0) return parts.join(' ').trim();
  return 'Unknown';
}

function resolveFilingDate(src: EfdSource): string {
  return src.date_filed ?? src.filing_date ?? '';
}

function hitToRawTransaction(hit: EfdHit): RawTransaction {
  const s = hit._source;
  return {
    politician: resolveName(s),
    transaction_date: s.transaction_date ?? '',
    filing_date: resolveFilingDate(s),
    ticker: s.ticker ?? '',
    asset_name: s.asset_name ?? '',
    asset_type: s.asset_type ?? '',
    type: s.transaction_type ?? '',
    amount: s.amount ?? '',
    owner: s.owner ?? '',
    source_id: hit._id,
    raw_json: s as Record<string, unknown>,
  };
}

// ─── Core page fetch ──────────────────────────────────────────────────────────

export async function fetchPage(
  offset: number,
  fromDate: string = isoDefaultStart(),
  toDate: string = isoToday(),
): Promise<FetchResult> {
  const url = buildUrl(fromDate, toDate, offset);
  log.info(`GET offset=${offset} from=${fromDate} to=${toDate}`);

  try {
    const response = await withRetry(
      () => axios.get<EfdResponse>(url, { headers: HEADERS, timeout: TIMEOUT_MS, proxy: getProxyConfig() }),
      3,
      500,
    );

    const hits = response.data?.hits?.hits;
    if (!Array.isArray(hits)) {
      log.warn('Unexpected response shape — hits.hits is not an array');
      return { success: true, records: [] };
    }

    const records = hits.map(hitToRawTransaction);
    log.info(`Page offset=${offset}: ${records.length} records`);
    return { success: true, records };
  } catch (err) {
    const message = toAxiosMessage(err);
    log.error(`fetchPage failed at offset=${offset}: ${message}`);
    return { success: false, records: [], error: message };
  }
}

// ─── Paginated fetch-all ──────────────────────────────────────────────────────

export async function fetchAll(
  fromDate: string = isoDefaultStart(),
  toDate: string = isoToday(),
): Promise<FetchResult> {
  log.info(`fetchAll from=${fromDate} to=${toDate}`);

  // First page — also tells us the total count
  const firstUrl = buildUrl(fromDate, toDate, 0);
  let total: number;
  let allRecords: RawTransaction[] = [];

  try {
    const firstResponse = await withRetry(
      () => axios.get<EfdResponse>(firstUrl, { headers: HEADERS, timeout: TIMEOUT_MS }),
      3,
      500,
    );

    const hits = firstResponse.data?.hits?.hits;
    if (!Array.isArray(hits)) {
      return { success: false, records: [], error: 'Unexpected response shape on first page' };
    }

    total = totalCount(firstResponse.data);
    allRecords = hits.map(hitToRawTransaction);
    log.info(`Total records reported by API: ${total}`);
  } catch (err) {
    const message = toAxiosMessage(err);
    log.error(`fetchAll first-page failed: ${message}`);
    return { success: false, records: [], error: message };
  }

  // Remaining pages
  let offset = PAGE_SIZE;
  while (offset < total) {
    const result = await fetchPage(offset, fromDate, toDate);
    if (!result.success) {
      // Partial success — return what we have with a warning
      log.warn(`Stopping pagination early at offset=${offset}: ${result.error}`);
      return {
        success: false,
        records: allRecords,
        error: `Partial fetch (${allRecords.length}/${total}): ${result.error}`,
      };
    }
    if (result.records.length === 0) break; // API returned empty page before total — stop
    allRecords.push(...result.records);
    offset += PAGE_SIZE;
  }

  log.info(`fetchAll complete: ${allRecords.length} records collected`);
  return { success: true, records: allRecords };
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function toAxiosMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    if (err.code === 'ECONNABORTED') return `Timeout after ${TIMEOUT_MS}ms`;
    if (err.response) return `HTTP ${err.response.status} ${err.response.statusText}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
