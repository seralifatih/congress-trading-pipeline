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

interface FilingIndex {
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

async function fetchPdfText(year: number, docId: string): Promise<string> {
  const res = await axios.get<ArrayBuffer>(ptrPdfUrl(year, docId), {
    headers: HEADERS,
    timeout: TIMEOUT_MS,
    responseType: 'arraybuffer',
  });
  const data = await pdfParse(Buffer.from(res.data));
  return data.text;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function isoToday(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

function isoDefaultStart(): string {
  return format(subDays(new Date(), config.FETCH_DAYS_BACK), 'yyyy-MM-dd');
}

export async function fetchAllHouse(
  fromDate: string = isoDefaultStart(),
  toDate: string = isoToday(),
): Promise<FetchResult> {
  log.info(`fetchAllHouse from=${fromDate} to=${toDate}`);

  const year = new Date().getFullYear();

  // 1) Download + extract index
  let filings: FilingIndex[];
  try {
    const zipBuf = await withRetry(() => downloadZip(year), 3, 1000);
    const xml = extractIndexXml(zipBuf, year);
    filings = parseIndex(xml, year, fromDate, toDate);
    log.info(`House index: ${filings.length} PTR filings in window`);
  } catch (err) {
    const message = err instanceof AxiosError ? err.message : String(err);
    log.error(`House index fetch failed: ${message}`);
    return { success: false, records: [], error: `House index: ${message}` };
  }

  if (filings.length === 0) {
    return { success: true, records: [] };
  }

  // 2) Fetch each PDF, parse rows
  const records: RawTransaction[] = [];
  let errors = 0;
  let scanned = 0;

  const debugLimit = process.env['DEBUG_PTR_LIMIT'] ? parseInt(process.env['DEBUG_PTR_LIMIT'], 10) : 0;
  const filingsToFetch = debugLimit > 0 ? filings.slice(0, debugLimit) : filings;
  if (debugLimit > 0) {
    log.warn(`DEBUG_PTR_LIMIT=${debugLimit} — fetching subset only`);
  }

  for (let i = 0; i < filingsToFetch.length; i++) {
    const f = filingsToFetch[i]!;
    try {
      const text = await withRetry(() => fetchPdfText(f.year, f.docId), 2, 500);
      const parsed = parseHousePtrText({
        text,
        member: f.member,
        filingDate: f.filingDate,
        docId: f.docId,
      });
      if (parsed.length === 0) scanned++;
      records.push(...parsed);
    } catch (err) {
      errors++;
      log.warn(`House PTR ${f.docId} (${f.member}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if ((i + 1) % 25 === 0 || i === filingsToFetch.length - 1) {
      log.info(`House progress: ${i + 1}/${filingsToFetch.length} PTRs → ${records.length} txs (${scanned} unparseable)`);
    }
    if (i < filingsToFetch.length - 1) await delay(PDF_DELAY_MS);
  }

  log.info(
    `fetchAllHouse complete: ${filingsToFetch.length} filings → ${records.length} txs, ${scanned} unparseable, ${errors} errors`,
  );

  const partial = errors > filingsToFetch.length / 4;
  return {
    success: !partial,
    records,
    error: partial ? `${errors}/${filings.length} House PDF fetches failed` : undefined,
  };
}
