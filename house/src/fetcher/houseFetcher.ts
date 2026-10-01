import axios, { AxiosError } from 'axios';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import pdfParse from 'pdf-parse';
import { format, subDays, parse as parseDate, isValid } from 'date-fns';
import type { FetchResult, RawTransaction } from '../types/index.js';
import { makeLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { withRetry } from '../utils/retry.js';
import { parseHousePtrText } from '../parser/housePdfParser.js';
import { attemptOcr, terminateOcrWorker } from '../ocr/index.js';

const log = makeLogger('houseFetcher');

const TIMEOUT_MS = 60_000;
const PDF_DELAY_MS = 600;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'application/zip, application/pdf, text/xml, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function zipUrl(year: number): string {
  return `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
}

function ptrPdfUrl(year: number, docId: string): string {
  return `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
}

// ─── XML index types ──────────────────────────────────────────────────────────

interface RawMember {
  Prefix?: string;
  Last?: string;
  First?: string;
  Suffix?: string;
  FilingType?: string;
  StateDst?: string;
  Year?: string | number;
  FilingDate?: string;
  DocID?: string | number;
}

export interface FilingIndex {
  member: string;
  filingDate: string;       // YYYY-MM-DD
  filingDateRaw: string;    // M/D/YYYY as in XML
  docId: string;
  year: number;
}

function normalizeFilingDate(raw: string): string | null {
  for (const fmt of ['M/d/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd']) {
    const parsed = parseDate(raw, fmt, new Date());
    if (isValid(parsed)) return format(parsed, 'yyyy-MM-dd');
  }
  return null;
}

function memberName(m: RawMember): string {
  return [m.First, m.Last, m.Suffix].filter(Boolean).join(' ').trim();
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ─── Fetch + extract index ────────────────────────────────────────────────────

async function downloadZip(year: number): Promise<Buffer> {
  log.info(`Downloading ${year}FD.zip`);
  const res = await axios.get<ArrayBuffer>(zipUrl(year), {
    headers: HEADERS,
    timeout: TIMEOUT_MS,
    responseType: 'arraybuffer',
  });
  return Buffer.from(res.data);
}

function extractIndexXml(zipBuf: Buffer, year: number): string {
  const zip = new AdmZip(zipBuf);
  const xmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(`${year}fd.xml`));
  if (!xmlEntry) {
    throw new Error(`No ${year}FD.xml inside ${year}FD.zip`);
  }
  return xmlEntry.getData().toString('utf-8');
}

function parseIndex(xml: string, year: number, fromDate: string, toDate: string): FilingIndex[] {
  const parser = new XMLParser({ ignoreAttributes: false });
  const json = parser.parse(xml) as { FinancialDisclosure?: { Member?: RawMember | RawMember[] } };
  const rawMembers = json.FinancialDisclosure?.Member ?? [];
  const members = Array.isArray(rawMembers) ? rawMembers : [rawMembers];

  const out: FilingIndex[] = [];
  for (const m of members) {
    if (m.FilingType !== 'P') continue; // only Periodic Transaction Reports
    const name = memberName(m);
    const docId = String(m.DocID ?? '').trim();
    const filingDateRaw = String(m.FilingDate ?? '').trim();
    if (!name || !docId || !filingDateRaw) continue;

    const filingDate = normalizeFilingDate(filingDateRaw);
    if (!filingDate) continue;

    if (filingDate < fromDate || filingDate > toDate) continue;

    out.push({ member: name, filingDate, filingDateRaw, docId, year });
  }
  return out;
}

// ─── Per-PTR PDF fetch + parse ────────────────────────────────────────────────

interface FetchedPdf {
  text: string;
  buffer: Buffer;
}

async function fetchPdf(year: number, docId: string): Promise<FetchedPdf> {
  const res = await axios.get<ArrayBuffer>(ptrPdfUrl(year, docId), {
    headers: HEADERS,
    timeout: TIMEOUT_MS,
    responseType: 'arraybuffer',
  });
  const buffer = Buffer.from(res.data);
  const data = await pdfParse(buffer);
  return { text: data.text, buffer };
}

// ─── Public API ───────────────────────────────────────────────────────────────

function isoToday(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

function isoDefaultStart(): string {
  return format(subDays(new Date(), config.FETCH_DAYS_BACK), 'yyyy-MM-dd');
}

// ─── Early (pre-download) filtering ───────────────────────────────────────────
// The index carries filer name and filing date only. Both let us skip a filing
// BEFORE its PDF is downloaded and parsed:
//   - members: the index name is matched against the user's `members`.
//   - transactionDateFrom: a PTR can only report trades that already
//     happened, so every transaction in a filing is dated on or before its
//     filing date — a filing filed before transactionDateFrom cannot contain
//     a trade on/after it. (No equivalent prune for transactionDateTo: a
//     filing made today can report an old trade.)
// Tickers and the exact trade-date bounds need the parsed PDF and are applied
// row-by-row in the pipeline.

export interface EarlyFilterOptions {
  memberMatcher?: (displayName: string) => boolean;
  transactionDateFrom?: string;
}

export function filterFilingsEarly(
  filings: FilingIndex[],
  options: EarlyFilterOptions,
): { kept: FilingIndex[]; skippedByMember: number; skippedByTransactionDate: number } {
  let skippedByMember = 0;
  let skippedByTransactionDate = 0;
  const kept: FilingIndex[] = [];
  for (const f of filings) {
    if (options.memberMatcher && !options.memberMatcher(f.member)) {
      skippedByMember++;
      continue;
    }
    if (options.transactionDateFrom && f.filingDate < options.transactionDateFrom) {
      skippedByTransactionDate++;
      continue;
    }
    kept.push(f);
  }
  return { kept, skippedByMember, skippedByTransactionDate };
}

// Newest filing first (then highest DocID, which grows with time). The index
// itself is alphabetical by member, so processing it in index order meant a
// run that stopped early (charge cap, partial failure) lost everyone late in
// the alphabet. Newest-first makes a cut lose the OLDEST filings instead.
export function sortNewestFirst<T extends { filingDate: string; docId: string }>(filings: T[]): T[] {
  return [...filings].sort(
    (a, b) =>
      b.filingDate.localeCompare(a.filingDate) ||
      Number(b.docId) - Number(a.docId) ||
      b.docId.localeCompare(a.docId),
  );
}

// The index ZIP is per calendar year, so a window that crosses New Year needs
// both years' indexes. Never beyond the current year (no such ZIP yet).
export function indexYears(fromDate: string, toDate: string, currentYear: number): number[] {
  const first = Math.min(parseInt(fromDate.slice(0, 4), 10), currentYear);
  const last = Math.min(parseInt(toDate.slice(0, 4), 10), currentYear);
  const years: number[] = [];
  for (let y = first; y <= last; y++) years.push(y);
  return years.length > 0 ? years : [currentYear];
}

export interface FetchAllHouseOptions extends EarlyFilterOptions {
  // Override the DEBUG_PTR_LIMIT / ENABLE_OCR env vars. config.ts and this
  // module read the environment once at import time — before the Actor input
  // is known — so values taken from the input must be passed in.
  debugPtrLimit?: number;
  enableOcr?: boolean;
}

export async function fetchAllHouse(
  fromDate: string = isoDefaultStart(),
  toDate: string = isoToday(),
  options: FetchAllHouseOptions = {},
): Promise<FetchResult> {
  log.info(`fetchAllHouse from=${fromDate} to=${toDate}`);

  // 1) Download + extract index
  let allFilings: FilingIndex[];
  try {
    allFilings = [];
    for (const year of indexYears(fromDate, toDate, new Date().getFullYear())) {
      const zipBuf = await withRetry(() => downloadZip(year), 3, 1000);
      const xml = extractIndexXml(zipBuf, year);
      allFilings.push(...parseIndex(xml, year, fromDate, toDate));
    }
    log.info(`House index: ${allFilings.length} PTR filings in window`);
  } catch (err) {
    const message = err instanceof AxiosError ? err.message : String(err);
    log.error(`House index fetch failed: ${message}`);
    return {
      success: false, records: [], error: `House index: ${message}`,
      fetchFailedCount: 0, parseFailedCount: 0, ocrFilingCount: 0, ocrRowCount: 0,
    };
  }

  // Members / transactionDateFrom filters at the index level: a skipped
  // filing's PDF is never downloaded or parsed.
  const early = filterFilingsEarly(allFilings, options);
  if (early.skippedByMember > 0 || early.skippedByTransactionDate > 0) {
    log.info(
      `Early filters: ${early.kept.length}/${allFilings.length} filings kept ` +
      `(skipped ${early.skippedByMember} by members, ${early.skippedByTransactionDate} by transactionDateFrom)`,
    );
  }
  const earlyCounts = {
    skippedByMemberCount: early.skippedByMember,
    skippedByTransactionDateCount: early.skippedByTransactionDate,
  };
  const filings = sortNewestFirst(early.kept);

  if (filings.length === 0) {
    return { success: true, records: [], fetchFailedCount: 0, parseFailedCount: 0, ocrFilingCount: 0, ocrRowCount: 0, ...earlyCounts };
  }

  // 2) Fetch each PDF, parse rows
  const records: RawTransaction[] = [];
  let errors = 0;
  let fetchFailed = 0;
  let scanned = 0;
  let parseFailed = 0;
  let ocrFilings = 0;
  let ocrRows = 0;

  const debugLimit = options.debugPtrLimit ?? (process.env['DEBUG_PTR_LIMIT'] ? parseInt(process.env['DEBUG_PTR_LIMIT'], 10) : 0);
  const enableOcr = options.enableOcr ?? config.ENABLE_OCR;
  const filingsToFetch = debugLimit > 0 ? filings.slice(0, debugLimit) : filings;
  if (debugLimit > 0) {
    log.warn(`debugPtrLimit=${debugLimit} — fetching subset only (newest filings first)`);
  }

  for (let i = 0; i < filingsToFetch.length; i++) {
    const f = filingsToFetch[i]!;
    const pdfUrl = ptrPdfUrl(f.year, f.docId);
    try {
      const { text, buffer } = await withRetry(() => fetchPdf(f.year, f.docId), 2, 500);
      let parsed = parseHousePtrText({
        text,
        member: f.member,
        filingDate: f.filingDate,
        docId: f.docId,
        pdfUrl,
      });

      if (parsed.some((r) => r.parse_status === 'scanned_unparsed')) {
        // No text layer — try OCR before accepting the placeholder, but only
        // if explicitly enabled (see config.ts's ENABLE_OCR / src/ocr/
        // README.md): this is still a prototype with a known residual
        // failure mode, and running it unconditionally would spend ~96s of
        // CLI OCR compute per scanned filing for no recovered rows on the
        // one real filing measured so far. Disabled, this is byte-for-byte
        // the same scanned_unparsed behavior as before OCR existed.
        if (enableOcr) {
          // A known template must match AND every row must validate, or
          // this filing stays scanned_unparsed (all-or-nothing) — see
          // ocr/index.ts.
          const ocrResult = await attemptOcr(buffer, f.member, f.filingDate, f.docId, pdfUrl);
          if (ocrResult.succeeded) {
            parsed = ocrResult.rows;
            ocrFilings++;
            ocrRows += ocrResult.rows.length;
          } else {
            scanned++;
          }
        } else {
          scanned++;
        }
      }
      if (parsed.some((r) => r.parse_status === 'parse_failed')) parseFailed++;
      records.push(...parsed);
    } catch (err) {
      // The PDF download itself failed after withRetry's 2 retries —
      // network error, timeout, non-2xx, or a buffer pdf-parse couldn't
      // read. We never got to look at this filing's content at all. This
      // filing WAS enumerated in the House index, so silently continuing to
      // the next one would drop a known filing from output with no trace —
      // same reasoning as parseHousePtrText's parse_failed placeholder, one
      // layer up. Emit a fetch_failed placeholder instead: transient by
      // nature, so pipeline.ts's supersede step (see utils/dedup.ts
      // placeholdersByFilingId) replaces it with real rows the moment a
      // later run's fetch succeeds for this same filing_id.
      errors++;
      fetchFailed++;
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`House PTR ${f.docId} (${f.member}) failed: ${message} — emitting fetch_failed placeholder`);
      records.push({
        politician: f.member,
        transaction_date: '',
        filing_date: f.filingDate,
        ticker: '',
        asset_name: '',
        asset_type: '',
        type: '',
        amount: '',
        owner: '',
        source_id: `house_${f.docId}_fetch_failed`,
        filing_id: f.docId,
        filing_type: null,
        parse_status: 'fetch_failed',
        pdf_url: pdfUrl,
        ocr_confidence: null,
        raw_json: {
          source: 'house',
          doc_id: f.docId,
          fetch_error: message,
        },
      });
    }

    if ((i + 1) % 25 === 0 || i === filingsToFetch.length - 1) {
      log.info(
        `House progress: ${i + 1}/${filingsToFetch.length} PTRs → ${records.length} txs ` +
        `(${fetchFailed} fetch_failed, ${scanned} scanned, ${parseFailed} parse_failed, ${ocrFilings} ocr filings / ${ocrRows} ocr rows)`,
      );
    }
    if (i < filingsToFetch.length - 1) await delay(PDF_DELAY_MS);
  }

  await terminateOcrWorker();

  log.info(
    `fetchAllHouse complete: ${filingsToFetch.length} filings → ${records.length} txs, ` +
    `${fetchFailed} fetch_failed, ${scanned} scanned_unparsed, ${parseFailed} parse_failed, ${errors} errors, ` +
    `${ocrFilings} ocr filings / ${ocrRows} ocr rows`,
  );

  const partial = errors > filingsToFetch.length / 4;
  return {
    success: !partial,
    records,
    error: partial ? `${errors}/${filingsToFetch.length} House PDF fetches failed` : undefined,
    fetchFailedCount: fetchFailed,
    parseFailedCount: parseFailed,
    ocrFilingCount: ocrFilings,
    ocrRowCount: ocrRows,
    ...earlyCounts,
  };
}
