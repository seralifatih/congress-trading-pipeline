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

  // Disable axios's built-in redirect following so we can capture Set-Cookie
  // from every step of the redirect chain (Django sets sessionid on the 302,
  // not on the final 200, and axios's internal follower drops those headers).
  const client = axios.create({
    timeout: TIMEOUT_MS,
    httpsAgent: getHttpsAgent(),
    proxy: false,
    headers: BROWSER_HEADERS,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400, // accept 3xx so axios doesn't throw
  });

  client.interceptors.request.use(async (cfg: InternalAxiosRequestConfig) => {
    if (!cfg.url) return cfg;
    const fullUrl = cfg.url.startsWith('http') ? cfg.url : `${BASE}${cfg.url}`;
    const cookieHeader = await jar.getCookieString(fullUrl);
    if (cookieHeader) cfg.headers.set('Cookie', cookieHeader);
    return cfg;
  });

  client.interceptors.response.use(async (res: AxiosResponse) => {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : [setCookie];
      const requestedUrl = res.config.url?.startsWith('http')
        ? res.config.url
        : `${BASE}${res.config.url ?? ''}`;
      for (const c of list) {
        try { await jar.setCookie(c, requestedUrl); } catch { /* ignore */ }
      }
    }
    return res;
  });

  return { client, jar };
}

// ─── Manual redirect walker ──────────────────────────────────────────────────
// Calls client.get/post then follows 3xx Location headers manually so each
// hop's Set-Cookie is captured by the response interceptor.

async function followRedirects<T>(
  client: AxiosInstance,
  initial: () => Promise<AxiosResponse<T>>,
  maxHops: number = 5,
): Promise<AxiosResponse<T>> {
  let res = await initial();
  let hops = 0;

  while (res.status >= 300 && res.status < 400 && hops < maxHops) {
    const location = res.headers['location'];
    if (!location) break;
    const nextUrl = location.startsWith('http') ? location : `${BASE}${location}`;
    hops++;
    res = await client.get<T>(nextUrl, {
      headers: {
        Referer: res.config.url ?? BASE,
        Accept: res.config.headers?.['Accept'] as string | undefined ?? '*/*',
      },
      transformResponse: res.config.transformResponse,
    }) as AxiosResponse<T>;
  }

  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Too many redirects (>${maxHops}) starting from ${res.config.url}`);
  }
  return res;
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
  const homeRes = await followRedirects(client, () =>
    client.get<string>(HOME_URL, { transformResponse: (v) => v }),
  );

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

  await followRedirects(client, () =>
    client.post(HOME_URL, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: HOME_URL,
        Origin: BASE,
      },
    }),
  );

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
  // csrfmiddlewaretoken MUST be in body (Django CSRF middleware checks both
  // body and X-CSRFToken header).
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
    csrfmiddlewaretoken: csrf,
  });

  const res = await followRedirects(client, () =>
    client.post<DataTablesResponse>(DATA_URL, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRFToken': csrf,
        Referer: SEARCH_URL,
        Origin: BASE,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    }),
  );

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

// Electronic PTRs are served at /search/view/ptr/<uuid>/ — a structured HTML
// table we can parse row-by-row. Filings submitted on paper are served at
// /search/view/paper/<id>/ instead — a scanned image/PDF viewer, no table,
// no OCR fallback. The two paths are how the listing itself tells us which
// kind a filing is, before we ever fetch its detail page.
const PTR_PATH_RE = /\/ptr\/([a-f0-9-]+)/i;
const PAPER_PATH_RE = /\/paper\/([a-z0-9-]+)/i;

interface FilingMeta {
  politician: string;
  filing_date: string;
  report_path: string;
  doc_id: string;
  docType: 'ptr' | 'paper';
  office: string;
}

// Distinguishes "row too malformed to read at all" (missing name/date
// cells — not a filing-format signal, just bad row data) from "row was
// readable but its link matched neither /ptr/ nor /paper/" (a real,
// unrecognized filing-format signal worth counting — see
// unknownDocTypeCount in fetchAllFilings/fetchPage). Never silently merged:
// a caller that only checked for null would treat both the same way.
interface UnknownDocTypeRow {
  reportPath: string;
}

function rowToFilingMetaOrUnknown(row: string[]): FilingMeta | UnknownDocTypeRow | null {
  if (row.length < 5) return null;

  const [firstNameCell, lastNameCell, officeCell, reportCell, filedDateCell] = row;
  if (!firstNameCell || !lastNameCell || !reportCell || !filedDateCell) return null;

  const reportLinkMatch = reportCell.match(HREF_RE);
  const reportPath = reportLinkMatch?.[1] ?? '';

  const ptrMatch = reportPath.match(PTR_PATH_RE);
  const paperMatch = reportPath.match(PAPER_PATH_RE);
  const docType: 'ptr' | 'paper' | null = ptrMatch ? 'ptr' : paperMatch ? 'paper' : null;
  const docId = ptrMatch?.[1] ?? paperMatch?.[1];
  if (!docType || !docId) return { reportPath }; // Neither link shape — unrecognized, not unreadable

  return {
    politician: `${extractText(firstNameCell)} ${extractText(lastNameCell)}`.trim(),
    filing_date: extractText(filedDateCell),
    report_path: reportPath,
    doc_id: docId,
    docType,
    office: extractText(officeCell ?? ''),
  };
}

function isFilingMeta(v: FilingMeta | UnknownDocTypeRow | null): v is FilingMeta {
  return v !== null && 'docType' in v;
}

function isUnknownDocTypeRow(v: FilingMeta | UnknownDocTypeRow | null): v is UnknownDocTypeRow {
  return v !== null && !isFilingMeta(v);
}

// Kept for direct unit testing (tests/senateFetcher.test.js) — returns null
// for the unknown-link-shape case too, collapsing the distinction that
// rowToFilingMetaOrUnknown preserves for the production listing loops.
export function rowToFilingMeta(row: string[]): FilingMeta | null {
  const result = rowToFilingMetaOrUnknown(row);
  return isFilingMeta(result) ? result : null;
}

// ─── PTR detail page fetch + parse ────────────────────────────────────────────
// HTML at /search/view/ptr/<uuid>/ contains a table with columns:
//   #, Transaction Date, Owner, Ticker, Asset Name, Asset Type, Type, Amount, Comment
// (column count and order can vary slightly — parse defensively)

function isHomePageRedirect(html: string): boolean {
  // PTR detail page redirects to /search/home/ when session has expired
  // or terms haven't been accepted. Check for the form action + title.
  return /<title>\s*eFD:\s*Home\s*<\/title>/i.test(html)
      && /name=["']prohibition_agreement["']/i.test(html);
}

async function fetchPtrHtmlOnce(
  client: AxiosInstance,
  reportPath: string,
): Promise<{ html: string; status: number; finalUrl: string }> {
  const url = reportPath.startsWith('http') ? reportPath : `${BASE}${reportPath}`;
  const res = await followRedirects(client, () =>
    client.get<string>(url, {
      headers: {
        Referer: SEARCH_URL,
        Accept: 'text/html,application/xhtml+xml',
      },
      transformResponse: (v) => v,
    }),
  );
  if (typeof res.data !== 'string') {
    throw new Error(`PTR detail returned non-string body (status ${res.status})`);
  }
  const finalUrl = res.config.url ?? url;
  return { html: res.data, status: res.status, finalUrl };
}

/**
 * Fetch a PTR detail page. If the response is a home-page redirect (session
 * lost terms acceptance), re-run the handshake and retry once.
 *
 * Returns { html, csrf } where csrf is the (possibly refreshed) token —
 * caller should propagate it for subsequent requests.
 */
async function fetchPtrHtml(
  client: AxiosInstance,
  jar: CookieJar,
  reportPath: string,
  csrf: string,
): Promise<{ html: string; csrf: string }> {
  const requested = reportPath.startsWith('http') ? reportPath : `${BASE}${reportPath}`;
  let result = await fetchPtrHtmlOnce(client, reportPath);

  // Detect redirect-to-home in two ways: final URL contains /home/ OR HTML body matches
  const wasRedirected = result.finalUrl.includes('/search/home') || isHomePageRedirect(result.html);
  if (wasRedirected) {
    log.warn(
      `PTR redirected — req=${requested} final=${result.finalUrl} status=${result.status}; re-handshake`,
    );
    const newCsrf = await handshake(client, jar);
    result = await fetchPtrHtmlOnce(client, reportPath);

    if (result.finalUrl.includes('/search/home') || isHomePageRedirect(result.html)) {
      log.warn(
        `PTR still redirected after re-handshake — final=${result.finalUrl}. Cookies in jar:`,
      );
      const cookies = await jar.getCookies(BASE);
      log.warn(`  ${cookies.map((c) => `${c.key}=${c.value.slice(0, 8)}...`).join('; ')}`);
    }

    return { html: result.html, csrf: newCsrf };
  }

  return { html: result.html, csrf };
}

// ─── Filing type ──────────────────────────────────────────────────────────────
// The PTR detail page heading reads "Periodic Transaction Report for
// MM/DD/YYYY" for an original, or "... (Amendment N)" for an amendment. This
// is the only signal the Senate eFD source exposes — there is no structured
// field, link, or id referencing which prior filing an amendment supersedes.
// Confirmed against live filings, e.g. Boozman PTR 4184cc9a-78e0-45f3-84f7-
// 642011e6ff98 ("... (Amendment 1)") vs 4a558db2-e492-4e8f-8a28-7b703a5c8e08
// (no suffix). Never inferred from duplicate documents — null if the heading
// doesn't match either shape.

const AMENDMENT_HEADING_RE = /\(Amendment\s+(\d+)\)/i;

function parseFilingType(html: string): { filing_type: 'original' | 'amendment' | null; amendment_number: number | null } {
  const $ = cheerio.load(html);
  const heading = $('h1, h2, h3').first().text().replace(/\s+/g, ' ').trim();
  if (!heading) return { filing_type: null, amendment_number: null };

  const amendMatch = heading.match(AMENDMENT_HEADING_RE);
  if (amendMatch) {
    return { filing_type: 'amendment', amendment_number: parseInt(amendMatch[1]!, 10) };
  }
  if (/Periodic Transaction Report/i.test(heading)) {
    return { filing_type: 'original', amendment_number: null };
  }
  return { filing_type: null, amendment_number: null };
}

// A /ptr/ link's detail page had zero table rows. Distinct from a paper
// filing (that's a separate link shape, caught before we ever fetch the
// detail page) — this means the HTML table selectors below didn't match
// something they should have: a parser bug or a Senate EFD layout change.
// Never turned into a placeholder row (it isn't a known-unreadable filing,
// it's an unexplained one) — the caller just counts it via `isEmpty` so
// production runs surface how often it happens.
interface PtrParseResult {
  records: RawTransaction[];
  isEmpty: boolean;
}

export function parsePtrTransactions(html: string, meta: FilingMeta): PtrParseResult {
  const $ = cheerio.load(html);
  const out: RawTransaction[] = [];
  const { filing_type, amendment_number } = parseFilingType(html);

  // Try multiple selectors — Senate EFD layout has shifted over time
  let rows = $('table tbody tr');
  if (rows.length === 0) rows = $('table.table tr').filter((_, el) => $(el).find('td').length > 0);
  if (rows.length === 0) rows = $('table tr').filter((_, el) => $(el).find('td').length > 0);

  if (rows.length === 0) {
    // Diagnostic: log title, first form, table count, and first 500 chars
    const title = $('title').text().trim();
    const tableCount = $('table').length;
    const formAction = $('form').first().attr('action') ?? '(none)';
    const snippet = html.slice(0, 600).replace(/\s+/g, ' ');
    log.warn(`PTR ${meta.doc_id}: no rows. title="${title}" tables=${tableCount} form="${formAction}"`);
    log.warn(`PTR ${meta.doc_id} html-head: ${snippet}`);
    return { records: out, isEmpty: true };
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
      source_id: `${meta.doc_id}|${idx}`,
      filing_type,
      amendment_number,
      parse_status: 'ok',
      pdf_url: null,
      raw_json: {
        ptr_uuid: meta.doc_id,
        row_index: idx,
        cells,
        office: meta.office,
      },
    });
  });

  return { records: out, isEmpty: false };
}

// ─── Paper filing placeholder ─────────────────────────────────────────────────
// A filing submitted on paper has no per-transaction data to extract — the
// whole filing is one scanned image/PDF, no OCR fallback. Mirrors House's
// scanned-PDF placeholder (housePdfParser.ts) for schema parity: every
// transaction-detail field is blank/null after normalize.ts, and pdf_url
// points at the filing's own detail page (Senate has no per-row PDF even for
// electronic filings, so "the detail page" is the closest equivalent here).

export function buildPaperPlaceholder(meta: FilingMeta): RawTransaction {
  const detailUrl = meta.report_path.startsWith('http')
    ? meta.report_path
    : `${BASE}${meta.report_path}`;

  return {
    politician: meta.politician,
    transaction_date: '',
    filing_date: meta.filing_date,
    ticker: '',
    asset_name: '',
    asset_type: '',
    type: '',
    amount: '',
    owner: '',
    source_id: `${meta.doc_id}|paper`,
    filing_type: null,
    amendment_number: null,
    parse_status: 'scanned_unparsed',
    pdf_url: detailUrl,
    raw_json: {
      doc_id: meta.doc_id,
      docType: 'paper',
      office: meta.office,
      paper: true,
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

// ─── Per-PTR detail fetch with rate limiting ─────────────────────────────────

const PTR_DELAY_MS = 1250; // open-source convention — be a polite citizen
// Optional debug cap — set DEBUG_PTR_LIMIT=N in env to fetch only N PTRs
const DEBUG_PTR_LIMIT = process.env['DEBUG_PTR_LIMIT']
  ? parseInt(process.env['DEBUG_PTR_LIMIT'], 10)
  : 0;

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Max example URLs to log per run — enough to spot a pattern without
// flooding the log if a Senate EFD layout change breaks classification for
// many rows at once.
const MAX_UNKNOWN_DOC_TYPE_EXAMPLES = 5;

// Splits a batch of raw listing rows into recognized FilingMeta plus a
// running unknown-link-shape tally, logging each unknown row's URL (up to
// the cap) as it's found — never silently dropped. `seenSoFar` lets callers
// accumulate the cap across multiple listing pages in one run.
export function collectFilings(
  rows: string[][],
  unknownExamples: string[],
): { filings: FilingMeta[]; unknownCount: number } {
  const filings: FilingMeta[] = [];
  let unknownCount = 0;

  for (const row of rows) {
    const result = rowToFilingMetaOrUnknown(row);
    if (isFilingMeta(result)) {
      filings.push(result);
    } else if (isUnknownDocTypeRow(result)) {
      unknownCount++;
      const url = result.reportPath.startsWith('http') ? result.reportPath : `${BASE}${result.reportPath}`;
      if (unknownExamples.length < MAX_UNKNOWN_DOC_TYPE_EXAMPLES) {
        unknownExamples.push(url);
        log.warn(`Unrecognized listing link (neither /ptr/ nor /paper/): ${url}`);
      }
    }
    // result === null: row too malformed to read (missing name/date cells) —
    // not a filing-format signal, already covered by existing row-shape guards.
  }

  return { filings, unknownCount };
}

async function fetchAllFilings(
  client: AxiosInstance,
  csrf: string,
  fromDate: string,
  toDate: string,
): Promise<{
  filings: FilingMeta[];
  total: number;
  partial: boolean;
  unknownDocTypeCount: number;
  unknownDocTypeExamples: string[];
  error?: string;
}> {
  const filings: FilingMeta[] = [];
  const unknownDocTypeExamples: string[] = [];
  let unknownDocTypeCount = 0;
  let total = 0;
  let drawCounter = 1;

  try {
    const first = await withRetry(
      () => fetchDataPage(client, csrf, 0, fromDate, toDate, drawCounter++),
      3,
      500,
    );
    total = first.recordsFiltered ?? first.recordsTotal ?? 0;
    const collected = collectFilings(first.data, unknownDocTypeExamples);
    filings.push(...collected.filings);
    unknownDocTypeCount += collected.unknownCount;
    log.info(`Listing: ${total} filings reported`);
  } catch (err) {
    return { filings, total: 0, partial: true, unknownDocTypeCount, unknownDocTypeExamples, error: toAxiosMessage(err) };
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
      const collected = collectFilings(page.data, unknownDocTypeExamples);
      filings.push(...collected.filings);
      unknownDocTypeCount += collected.unknownCount;
      offset += PAGE_SIZE;
    } catch (err) {
      return {
        filings,
        total,
        partial: true,
        unknownDocTypeCount,
        unknownDocTypeExamples,
        error: `Listing pagination stopped at offset=${offset}: ${toAxiosMessage(err)}`,
      };
    }
  }

  if (unknownDocTypeCount > 0) {
    log.warn(
      `${unknownDocTypeCount} listing row(s) had an unrecognized link shape ` +
      `(neither /ptr/ nor /paper/) — see examples above`,
    );
  }

  return { filings, total, partial: false, unknownDocTypeCount, unknownDocTypeExamples };
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

    const unknownDocTypeExamples: string[] = [];
    const { filings, unknownCount: unknownDocTypeCount } = collectFilings(response.data, unknownDocTypeExamples);

    const records: RawTransaction[] = [];
    let electronicPtrCount = 0;
    let paperCount = 0;
    let emptyPtrCount = 0;
    let activeCsrf = csrf;

    for (let i = 0; i < filings.length; i++) {
      const meta = filings[i]!;

      if (meta.docType === 'paper') {
        paperCount++;
        records.push(buildPaperPlaceholder(meta));
        continue; // No detail page worth fetching — it's a scanned image/PDF
      }

      try {
        const result = await fetchPtrHtml(client, jar, meta.report_path, activeCsrf);
        activeCsrf = result.csrf;
        const { records: txs, isEmpty } = parsePtrTransactions(result.html, meta);
        records.push(...txs);
        if (isEmpty) emptyPtrCount++;
        else electronicPtrCount++;
      } catch (err) {
        log.warn(`PTR ${meta.doc_id} fetch failed: ${toAxiosMessage(err)}`);
      }
      if (i < filings.length - 1) await delay(PTR_DELAY_MS);
    }

    log.info(
      `Page offset=${offset}: ${filings.length} filings → ${records.length} transactions ` +
      `(electronic=${electronicPtrCount}, paper=${paperCount}, empty=${emptyPtrCount}, unknownDocType=${unknownDocTypeCount})`,
    );
    return {
      success: true,
      records,
      electronicPtrCount,
      paperCount,
      emptyPtrCount,
      unknownDocTypeCount,
      unknownDocTypeExamples,
    };
  } catch (err) {
    const message = toAxiosMessage(err);
    log.error(`fetchPage failed at offset=${offset}: ${message}`);
    return {
      success: false,
      records: [],
      error: message,
      electronicPtrCount: 0,
      paperCount: 0,
      emptyPtrCount: 0,
      unknownDocTypeCount: 0,
      unknownDocTypeExamples: [],
    };
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
    return {
      success: false,
      records: [],
      error: `Handshake failed: ${message}`,
      electronicPtrCount: 0,
      paperCount: 0,
      emptyPtrCount: 0,
      unknownDocTypeCount: 0,
      unknownDocTypeExamples: [],
    };
  }

  // Phase 1: collect all filings via DataTables listing
  const listing = await fetchAllFilings(client, csrf, fromDate, toDate);
  if (listing.filings.length === 0) {
    return {
      success: !listing.partial,
      records: [],
      error: listing.error ?? 'No filings found',
      electronicPtrCount: 0,
      paperCount: 0,
      emptyPtrCount: 0,
      unknownDocTypeCount: listing.unknownDocTypeCount,
      unknownDocTypeExamples: listing.unknownDocTypeExamples,
    };
  }
  log.info(`Listing complete: ${listing.filings.length} PTR filings collected`);

  // Phase 2: fetch each PTR detail page, parse transactions
  const allRecords: RawTransaction[] = [];
  let detailErrors = 0;
  let electronicPtrCount = 0;
  let paperCount = 0;
  let emptyPtrCount = 0;

  const filingsToFetch = DEBUG_PTR_LIMIT > 0
    ? listing.filings.slice(0, DEBUG_PTR_LIMIT)
    : listing.filings;
  if (DEBUG_PTR_LIMIT > 0) {
    log.warn(`DEBUG_PTR_LIMIT=${DEBUG_PTR_LIMIT} — fetching subset only`);
  }

  let activeCsrf = csrf;
  for (let i = 0; i < filingsToFetch.length; i++) {
    const meta = filingsToFetch[i]!;

    if (meta.docType === 'paper') {
      paperCount++;
      allRecords.push(buildPaperPlaceholder(meta));
      continue; // No detail page worth fetching — it's a scanned image/PDF
    }

    try {
      const result = await withRetry(
        () => fetchPtrHtml(client, jar, meta.report_path, activeCsrf),
        2,
        500,
      );
      activeCsrf = result.csrf;
      const { records: txs, isEmpty } = parsePtrTransactions(result.html, meta);
      allRecords.push(...txs);
      if (isEmpty) emptyPtrCount++;
      else electronicPtrCount++;
      if ((i + 1) % 10 === 0 || i === filingsToFetch.length - 1) {
        log.info(`Detail progress: ${i + 1}/${filingsToFetch.length} PTRs → ${allRecords.length} txs`);
      }
    } catch (err) {
      detailErrors++;
      log.warn(`PTR ${meta.doc_id} (${meta.politician}) detail fetch failed: ${toAxiosMessage(err)}`);
    }
    if (i < filingsToFetch.length - 1) await delay(PTR_DELAY_MS);
  }

  log.info(
    `fetchAll complete: ${listing.filings.length} filings → ${allRecords.length} transactions, ` +
    `${detailErrors} detail errors (electronic=${electronicPtrCount}, paper=${paperCount}, ` +
    `empty=${emptyPtrCount}, unknownDocType=${listing.unknownDocTypeCount})`,
  );

  // Partial = listing was incomplete OR ≥25% of detail fetches failed
  const partialDetail = detailErrors > listing.filings.length / 4;
  if (listing.partial || partialDetail) {
    return {
      success: false,
      records: allRecords,
      error: listing.error ?? `${detailErrors}/${listing.filings.length} PTR detail fetches failed`,
      electronicPtrCount,
      paperCount,
      emptyPtrCount,
      unknownDocTypeCount: listing.unknownDocTypeCount,
      unknownDocTypeExamples: listing.unknownDocTypeExamples,
    };
  }

  return {
    success: true,
    records: allRecords,
    electronicPtrCount,
    paperCount,
    emptyPtrCount,
    unknownDocTypeCount: listing.unknownDocTypeCount,
    unknownDocTypeExamples: listing.unknownDocTypeExamples,
  };
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
