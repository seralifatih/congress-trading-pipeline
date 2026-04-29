import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig, AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar } from 'tough-cookie';
import { format, subDays } from 'date-fns';
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
): Promise<DataTablesResponse> {
  const body = {
    start,
    length: PAGE_SIZE,
    report_types: `[${REPORT_TYPE_PTR}]`,
    filer_types: '[]',
    submitted_start_date: toMmDdYyyy(fromDate),
    submitted_end_date: toMmDdYyyy(toDate),
    candidate_state: '',
    senator_state: '',
    office_id: '',
    first_name: '',
    last_name: '',
    submit: 'Search Reports',
  };

  const res = await client.post<DataTablesResponse>(DATA_URL, body, {
    headers: {
      'Content-Type': 'application/json',
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

// ─── Row → RawTransaction mapping ─────────────────────────────────────────────
// One row from DataTables = one PTR FILING (not one transaction).
// Transactions are inside the PTR document itself. For MVP we record the
// filing metadata; Phase 2 will fetch each PTR and parse line items.

const HREF_RE = /href=["']([^"']+)["']/;

function extractText(htmlOrText: string): string {
  return htmlOrText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function rowToRawTransaction(row: string[]): RawTransaction | null {
  if (row.length < 5) return null;

  const [firstNameCell, lastNameCell, officeCell, reportCell, filedDateCell] = row;
  if (!firstNameCell || !lastNameCell || !reportCell || !filedDateCell) return null;

  const firstName = extractText(firstNameCell);
  const lastName = extractText(lastNameCell);
  const politician = `${firstName} ${lastName}`.trim();

  const reportLinkMatch = reportCell.match(HREF_RE);
  const reportPath = reportLinkMatch?.[1] ?? '';
  const reportLabel = extractText(reportCell);

  // source_id = ptr UUID from URL path; falls back to politician+date+label
  const uuidMatch = reportPath.match(/\/ptr\/([a-f0-9-]+)/i);
  const sourceId = uuidMatch?.[1] ?? `${politician}|${filedDateCell}|${reportLabel}`;

  return {
    politician,
    transaction_date: '',                 // not in listing — comes from PTR detail page
    filing_date: extractText(filedDateCell),
    ticker: '',
    asset_name: reportLabel,              // listing only has report label; PTR detail has assets
    asset_type: extractText(officeCell ?? ''),
    type: '',
    amount: '',
    owner: '',
    source_id: sourceId,
    raw_json: {
      first_name: firstName,
      last_name: lastName,
      office: extractText(officeCell ?? ''),
      report_label: reportLabel,
      report_path: reportPath,
      filed_date: extractText(filedDateCell),
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

function isoToday(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

function isoDefaultStart(): string {
  return format(subDays(new Date(), config.FETCH_DAYS_BACK), 'yyyy-MM-dd');
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
      () => fetchDataPage(client, csrf, offset, fromDate, toDate),
      3,
      500,
    );

    const records = response.data
      .map(rowToRawTransaction)
      .filter((r): r is RawTransaction => r !== null);

    log.info(`Page offset=${offset}: ${records.length}/${response.data.length} rows mapped`);
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

  let total: number;
  let allRecords: RawTransaction[] = [];

  try {
    const first = await withRetry(
      () => fetchDataPage(client, csrf, 0, fromDate, toDate),
      3,
      500,
    );
    total = first.recordsFiltered ?? first.recordsTotal ?? 0;
    allRecords = first.data
      .map(rowToRawTransaction)
      .filter((r): r is RawTransaction => r !== null);
    log.info(`Total records reported by API: ${total}`);
  } catch (err) {
    const message = toAxiosMessage(err);
    log.error(`fetchAll first-page failed: ${message}`);
    return { success: false, records: [], error: message };
  }

  let offset = PAGE_SIZE;
  while (offset < total) {
    try {
      const page = await withRetry(
        () => fetchDataPage(client, csrf, offset, fromDate, toDate),
        3,
        500,
      );
      if (page.data.length === 0) break;
      const mapped = page.data
        .map(rowToRawTransaction)
        .filter((r): r is RawTransaction => r !== null);
      allRecords.push(...mapped);
      offset += PAGE_SIZE;
    } catch (err) {
      const message = toAxiosMessage(err);
      log.warn(`Stopping pagination early at offset=${offset}: ${message}`);
      return {
        success: false,
        records: allRecords,
        error: `Partial fetch (${allRecords.length}/${total}): ${message}`,
      };
    }
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
