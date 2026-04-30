import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig, AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar } from 'tough-cookie';
import { format, subDays } from 'date-fns';
import * as cheerio from 'cheerio';
import type { Agent } from 'https';
import type { FetchResult, RawTransaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { withRetry } from '../utils/retry.js';

const log = makeLogger('senateFetcher');

const BASE = 'https://efdsearch.senate.gov';
const HOME_URL = `${BASE}/search/home/`;
const SEARCH_URL = `${BASE}/search/`;
const DATA_URL = `${BASE}/search/report/data/`;
const PAGE_SIZE = 100;
const TIMEOUT_MS = 20_000;

const REPORT_TYPE_PTR = '11'; // Periodic Transaction Report

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

// ─── Apify Proxy ──────────────────────────────────────────────────────────────

let cachedAgent: Agent | undefined | null = null;

function getHttpsAgent(): Agent | undefined {
  if (cachedAgent !== null) return cachedAgent;

  const raw = process.env['APIFY_PROXY_URL'];
  if (!raw) {
    cachedAgent = undefined;
    return undefined;
  }

  try {
    cachedAgent = new HttpsProxyAgent(raw) as unknown as Agent;
    log.info('Routing via Apify Proxy (HttpsProxyAgent)');
    return cachedAgent;
  } catch {
    log.warn(`Invalid APIFY_PROXY_URL: ${raw}`);
    cachedAgent = undefined;
    return undefined;
  }
}

// ─── HTTP client with cookie jar ──────────────────────────────────────────────

function createClient(): { client: AxiosInstance; jar: CookieJar } {
  const jar = new CookieJar();
  const client = axios.create({
    timeout: TIMEOUT_MS,
    httpsAgent: getHttpsAgent(),
    proxy: false,
    headers: BROWSER_HEADERS,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  // Manual cookie jar — request: attach Cookie header from jar
  client.interceptors.request.use(async (cfg: InternalAxiosRequestConfig) => {
    if (!cfg.url) return cfg;
    const fullUrl = cfg.url.startsWith('http') ? cfg.url : `${BASE}${cfg.url}`;
    const cookieHeader = await jar.getCookieString(fullUrl);
    if (cookieHeader) cfg.headers.set('Cookie', cookieHeader);
    return cfg;
  });

  // Manual cookie jar — response: persist Set-Cookie headers into jar
  client.interceptors.response.use(async (res: AxiosResponse) => {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : [setCookie];
      const fullUrl = res.config.url?.startsWith('http')
        ? res.config.url
        : `${BASE}${res.config.url ?? ''}`;
      for (const c of list) {
        try { await jar.setCookie(c, fullUrl); } catch { /* malformed cookie — ignore */ }
      }
    }
    return res;
  });

  return { client, jar };
}

// ─── CSRF token extraction ────────────────────────────────────────────────────

function extractCsrfFromHtml(html: string): string | null {
  // Django renders: <input type="hidden" name="csrfmiddlewaretoken" value="...">
  const match = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/);
  return match?.[1] ?? null;
}

async function getCsrfFromCookie(jar: CookieJar, url: string): Promise<string | null> {
  const cookies = await jar.getCookies(url);
  const csrf = cookies.find((c) => c.key === 'csrftoken');
  return csrf?.value ?? null;
}

// ─── Step 1+2: handshake — accept terms, get session ─────────────────────────

async function handshake(client: AxiosInstance, jar: CookieJar): Promise<string> {
  log.info('Handshake: GET /search/home/');
  const homeRes = await client.get(HOME_URL);

  if (typeof homeRes.data !== 'string') {
    throw new Error(`Home page returned non-HTML response (status ${homeRes.status})`);
  }

  const csrfFromForm = extractCsrfFromHtml(homeRes.data);
  if (!csrfFromForm) {
    throw new Error('Could not find csrfmiddlewaretoken in home page HTML');
  }

  log.info('Handshake: POST /search/home/ (accept terms)');
  const formData = new URLSearchParams({
    csrfmiddlewaretoken: csrfFromForm,
    prohibition_agreement: '1',
  });

  await client.post(HOME_URL, formData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: HOME_URL,
      Origin: BASE,
    },
    maxRedirects: 5,
  });

  // Cookie jar now holds session + fresh csrftoken
  const csrf = await getCsrfFromCookie(jar, BASE);
  if (!csrf) throw new Error('No csrftoken in cookie jar after handshake');
  log.info('Handshake complete');
  return csrf;
}

// ─── Step 3: data fetch ───────────────────────────────────────────────────────
// Senate EFD returns DataTables format. Each row is a string array:
//   [first_name_link, last_name, office_label, report_type_link, filed_date]
// `report_type_link` is HTML: <a href="/search/view/ptr/<uuid>/">Periodic Transaction Report</a>

interface DataTablesResponse {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: string[][];
}

function toMmDdYyyy(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split('-');
  return `${m}/${d}/${y}`;
}

async function fetchDataPage(
  client: AxiosInstance,
  csrf: string,
  start: number,
  fromDate: string,
  toDate: string,
  draw: number,
): Promise<DataTablesResponse> {
  // Form-encoded body — Django expects application/x-www-form-urlencoded.
  const body = new URLSearchParams({
    draw: String(draw),
    start: String(start),
    length: String(PAGE_SIZE),
    report_types: `[${REPORT_TYPE_PTR}]`,
    filer_types: '[]',
    submitted_start_date: `${toMmDdYyyy(fromDate)} 00:00:00`,
    submitted_end_date: `${toMmDdYyyy(toDate)} 23:59:59`,
    candidate_state: '',
    senator_state: '',
    office_id: '',
    first_name: '',
    last_name: '',
  });

  const res = await client.post<DataTablesResponse>(DATA_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRFToken': csrf,
      Referer: SEARCH_URL,
      Origin: BASE,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  });

  if (typeof res.data !== 'object' || !Array.isArray(res.data?.data)) {
    throw new Error(`Unexpected data response shape (status ${res.status})`);
  }

  return res.data;
}

// ─── Row → filing metadata ────────────────────────────────────────────────────
// One row from DataTables = one PTR FILING (not one transaction).
// We extract metadata + detail-page path, then fetch each PTR to get line items.

const HREF_RE = /href=["']([^"']+)["']/;

function extractText(htmlOrText: string): string {
  return htmlOrText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

interface FilingMeta {
  politician: string;
  filing_date: string;
  report_path: string;
  ptr_uuid: string;
  office: string;
}

function rowToFilingMeta(row: string[]): FilingMeta | null {
  if (row.length < 5) return null;

  const [firstNameCell, lastNameCell, officeCell, reportCell, filedDateCell] = row;
  if (!firstNameCell || !lastNameCell || !reportCell || !filedDateCell) return null;

  const reportLinkMatch = reportCell.match(HREF_RE);
  const reportPath = reportLinkMatch?.[1] ?? '';
  const uuidMatch = reportPath.match(/\/ptr\/([a-f0-9-]+)/i);
  if (!uuidMatch) return null; // No PTR link — can't fetch transactions

  return {
    politician: `${extractText(firstNameCell)} ${extractText(lastNameCell)}`.trim(),
    filing_date: extractText(filedDateCell),
    report_path: reportPath,
    ptr_uuid: uuidMatch[1]!,
    office: extractText(officeCell ?? ''),
  };
}

// ─── PTR detail page fetch + parse ────────────────────────────────────────────
// HTML at /search/view/ptr/<uuid>/ contains a table with columns:
//   #, Transaction Date, Owner, Ticker, Asset Name, Asset Type, Type, Amount, Comment
// (column count and order can vary slightly — parse defensively)

async function fetchPtrHtml(client: AxiosInstance, reportPath: string): Promise<string> {
  const url = reportPath.startsWith('http') ? reportPath : `${BASE}${reportPath}`;
  const res = await client.get<string>(url, {
    headers: { Referer: SEARCH_URL, Accept: 'text/html,application/xhtml+xml' },
    transformResponse: (v) => v, // keep raw string, axios tries to JSON-parse otherwise
  });
  if (typeof res.data !== 'string') {
    throw new Error(`PTR detail returned non-string body (status ${res.status})`);
  }
  return res.data;
}

function parsePtrTransactions(html: string, meta: FilingMeta): RawTransaction[] {
  const $ = cheerio.load(html);
  const out: RawTransaction[] = [];

  // The PTR page has one main table. Find rows with data cells.
  // Header pattern: # | Transaction Date | Owner | Ticker | Asset Name | Asset Type | Type | Amount | Comment
  const rows = $('table tbody tr');
  if (rows.length === 0) {
    log.warn(`PTR ${meta.ptr_uuid}: no table rows found`);
    return out;
  }

  rows.each((idx, el) => {
    const cells = $(el).find('td').toArray().map((c) => $(c).text().trim().replace(/\s+/g, ' '));
    if (cells.length < 8) return; // skip non-data rows

    const [, txDate, owner, ticker, assetName, assetType, txType, amount] = cells;
    if (!assetName) return;

    out.push({
      politician: meta.politician,
      transaction_date: txDate ?? '',
      filing_date: meta.filing_date,
      ticker: (ticker ?? '').trim(),
      asset_name: assetName,
      asset_type: assetType ?? '',
      type: txType ?? '',
      amount: amount ?? '',
      owner: owner ?? '',
      source_id: `${meta.ptr_uuid}|${idx}`,
      raw_json: {
        ptr_uuid: meta.ptr_uuid,
        row_index: idx,
        cells,
        office: meta.office,
      },
    });
  });

  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function isoToday(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

function isoDefaultStart(): string {
  return format(subDays(new Date(), config.FETCH_DAYS_BACK), 'yyyy-MM-dd');
}

// ─── Per-PTR detail fetch with rate limiting ─────────────────────────────────

const PTR_DELAY_MS = 1250; // open-source convention — be a polite citizen

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllFilings(
  client: AxiosInstance,
  csrf: string,
  fromDate: string,
  toDate: string,
): Promise<{ filings: FilingMeta[]; total: number; partial: boolean; error?: string }> {
  const filings: FilingMeta[] = [];
  let total = 0;
  let drawCounter = 1;

  try {
    const first = await withRetry(
      () => fetchDataPage(client, csrf, 0, fromDate, toDate, drawCounter++),
      3,
      500,
    );
    total = first.recordsFiltered ?? first.recordsTotal ?? 0;
    filings.push(...first.data.map(rowToFilingMeta).filter((f): f is FilingMeta => f !== null));
    log.info(`Listing: ${total} filings reported`);
  } catch (err) {
    return { filings, total: 0, partial: true, error: toAxiosMessage(err) };
  }

  let offset = PAGE_SIZE;
  while (offset < total) {
    try {
      const page = await withRetry(
        () => fetchDataPage(client, csrf, offset, fromDate, toDate, drawCounter++),
        3,
        500,
      );
      if (page.data.length === 0) break;
      filings.push(...page.data.map(rowToFilingMeta).filter((f): f is FilingMeta => f !== null));
      offset += PAGE_SIZE;
    } catch (err) {
      return {
        filings,
        total,
        partial: true,
        error: `Listing pagination stopped at offset=${offset}: ${toAxiosMessage(err)}`,
      };
    }
  }

  return { filings, total, partial: false };
}

export async function fetchPage(
  offset: number,
  fromDate: string = isoDefaultStart(),
  toDate: string = isoToday(),
): Promise<FetchResult> {
  const { client, jar } = createClient();

  try {
    const csrf = await withRetry(() => handshake(client, jar), 2, 750);
    const response = await withRetry(
      () => fetchDataPage(client, csrf, offset, fromDate, toDate, 1),
      3,
      500,
    );

    const filings = response.data
      .map(rowToFilingMeta)
      .filter((f): f is FilingMeta => f !== null);

    const records: RawTransaction[] = [];
    for (let i = 0; i < filings.length; i++) {
      const meta = filings[i]!;
      try {
        const html = await fetchPtrHtml(client, meta.report_path);
        records.push(...parsePtrTransactions(html, meta));
      } catch (err) {
        log.warn(`PTR ${meta.ptr_uuid} fetch failed: ${toAxiosMessage(err)}`);
      }
      if (i < filings.length - 1) await delay(PTR_DELAY_MS);
    }

    log.info(`Page offset=${offset}: ${filings.length} filings → ${records.length} transactions`);
    return { success: true, records };
  } catch (err) {
    const message = toAxiosMessage(err);
    log.error(`fetchPage failed at offset=${offset}: ${message}`);
    return { success: false, records: [], error: message };
  }
}

export async function fetchAll(
  fromDate: string = isoDefaultStart(),
  toDate: string = isoToday(),
): Promise<FetchResult> {
  log.info(`fetchAll from=${fromDate} to=${toDate}`);

  const { client, jar } = createClient();
  let csrf: string;

  try {
    csrf = await withRetry(() => handshake(client, jar), 2, 750);
  } catch (err) {
    const message = toAxiosMessage(err);
    log.error(`Handshake failed: ${message}`);
    return { success: false, records: [], error: `Handshake failed: ${message}` };
  }

  // Phase 1: collect all filings via DataTables listing
  const listing = await fetchAllFilings(client, csrf, fromDate, toDate);
  if (listing.filings.length === 0) {
    return {
      success: !listing.partial,
      records: [],
      error: listing.error ?? 'No filings found',
    };
  }
  log.info(`Listing complete: ${listing.filings.length} PTR filings collected`);

  // Phase 2: fetch each PTR detail page, parse transactions
  const allRecords: RawTransaction[] = [];
  let detailErrors = 0;

  for (let i = 0; i < listing.filings.length; i++) {
    const meta = listing.filings[i]!;
    try {
      const html = await withRetry(
        () => fetchPtrHtml(client, meta.report_path),
        2,
        500,
      );
      const txs = parsePtrTransactions(html, meta);
      allRecords.push(...txs);
      if ((i + 1) % 10 === 0 || i === listing.filings.length - 1) {
        log.info(`Detail progress: ${i + 1}/${listing.filings.length} PTRs → ${allRecords.length} txs`);
      }
    } catch (err) {
      detailErrors++;
      log.warn(`PTR ${meta.ptr_uuid} (${meta.politician}) detail fetch failed: ${toAxiosMessage(err)}`);
    }
    if (i < listing.filings.length - 1) await delay(PTR_DELAY_MS);
  }

  log.info(
    `fetchAll complete: ${listing.filings.length} filings → ${allRecords.length} transactions, ${detailErrors} detail errors`,
  );

  // Partial = listing was incomplete OR ≥25% of detail fetches failed
  const partialDetail = detailErrors > listing.filings.length / 4;
  if (listing.partial || partialDetail) {
    return {
      success: false,
      records: allRecords,
      error: listing.error ?? `${detailErrors}/${listing.filings.length} PTR detail fetches failed`,
    };
  }

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
