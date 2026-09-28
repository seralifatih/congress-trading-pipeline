const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHousePtrText } = require('../dist/parser/housePdfParser.js');
const { normalizeAll } = require('../dist/transformer/normalize.js');

function fixture(docId) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', `${docId}.txt`), 'utf-8');
}

// ── [GS] rows: transaction data glued onto the marker line, amount range
// split across a line break ("$15,001 -" / "$50,000") ─────────────────────

test('GS bond rows: 20035106 recovers both previously-dropped rows', () => {
  const rows = parseHousePtrText({
    text: fixture('20035106'),
    member: 'Donald Sternoff Beyer Jr',
    filingDate: '2026-08-01',
    docId: '20035106',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035106.pdf',
  });

  assert.equal(rows.length, 2);

  assert.equal(rows[0].asset_name, 'King Cnty Wash 4.00% 12/01/32');
  assert.equal(rows[0].type, 'exchange');
  assert.equal(rows[0].amount, '$15,001 - $50,000');
  assert.equal(rows[0].transaction_date, '07/26/2026');
  assert.equal(rows[0].owner, 'joint');

  assert.equal(rows[1].asset_name, 'Tri-Creek 5.00% 7/15/33');
  assert.equal(rows[1].type, 'Purchase');
  assert.equal(rows[1].amount, '$50,001 - $100,000');
});

test('GS bond rows: 20035349 recovers all three previously-dropped rows', () => {
  const rows = parseHousePtrText({
    text: fixture('20035349'),
    member: 'Donald Sternoff Beyer Jr',
    filingDate: '2026-09-01',
    docId: '20035349',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035349.pdf',
  });

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.asset_name),
    ['California St 4.00% 8/01/36', 'Long Is Pwr Auth Var 9/01/55', 'Washington St Various 5.00% 08/01/30'],
  );
  assert.deepEqual(rows.map((r) => r.type), ['exchange', 'Purchase', 'exchange']);
});

test('GS bond rows: 20035216 recovers the previously-dropped Treasury Note row', () => {
  const rows = parseHousePtrText({
    text: fixture('20035216'),
    member: 'Rob Bresnahan',
    filingDate: '2026-08-12',
    docId: '20035216',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035216.pdf',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].asset_name, 'US Treasury Note 06/30/27');
  assert.equal(rows[0].type, 'Purchase');
  assert.equal(rows[0].amount, '$15,001 - $50,000');
});

test('split-amount fix also recovers a plain stock row (not just [GS])', () => {
  // 20035260: Abbott Laboratories sale had its "$15,001 -" / "$50,000" split
  // across a line break too — same root cause as the [GS] bug, different
  // asset type. Regression guard: AMD/AVGO rows on the same filing (whose
  // amounts were never split) must still parse identically.
  const rows = parseHousePtrText({
    text: fixture('20035260'),
    member: 'Richard W. Allen',
    filingDate: '2026-08-18',
    docId: '20035260',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035260.pdf',
  });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].ticker, 'ABT');
  assert.equal(rows[0].amount, '$15,001 - $50,000');
  assert.equal(rows[1].ticker, 'AMD');
  assert.equal(rows[1].amount, '$1,001 - $15,000');
  assert.equal(rows[2].ticker, 'AVGO');
  assert.equal(rows[2].amount, '$1,001 - $15,000');
});

// ── Single exact-dollar amount (no "$X - $Y" bracket) ──────────────────────

test('20034999: single exact-dollar amount with cents ("$2,722.50") is recovered, not dropped', () => {
  // Wasserman Schultz / ICHR sale. Root cause: TX_RE required a "$X - $Y"
  // bracket range and integer-only digits — this filing reports a single
  // exact amount with cents instead, so the row never matched and
  // parseHousePtrText silently returned [] ("markers found but no rows
  // extracted"), which fetchAllHouse then couldn't distinguish from a
  // genuinely scanned filing.
  const rows = parseHousePtrText({
    text: fixture('20034999'),
    member: 'Debbie Wasserman Schultz',
    filingDate: '2026-07-14',
    docId: '20034999',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034999.pdf',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, 'ICHR');
  assert.equal(rows[0].asset_name, 'Ichor Holdings - Ordinary Shares');
  assert.equal(rows[0].type, 'Sale (Full)');
  assert.equal(rows[0].amount, '$2,722.50');
  assert.equal(rows[0].transaction_date, '06/17/2026');
  assert.equal(rows[0].parse_status, 'ok');
});

test('20034999: normalize() keeps the cents — amount_min and amount_max are both 2722.5, not truncated to 2722', () => {
  // Regression guard: stripAmount() used to run parseInt() on the cleaned
  // amount string, which silently truncates "2722.50" to 2722 (parseInt
  // stops at the first non-digit character, the decimal point). Fixed to
  // parseFloat() so a single exact-amount disclosure keeps its cents.
  const rows = parseHousePtrText({
    text: fixture('20034999'),
    member: 'Debbie Wasserman Schultz',
    filingDate: '2026-07-14',
    docId: '20034999',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034999.pdf',
  });
  const [t] = normalizeAll(rows);

  assert.equal(t.amount_min, 2722.5);
  assert.equal(t.amount_max, 2722.5);
});

// ── ASSET_TYPE_MAP: [ET]/[MF] marker codes ─────────────────────────────────

test('[ET] marker maps to asset_type "ETF"', () => {
  const rows = parseHousePtrText({
    text: fixture('90000001'),
    member: 'Test Member',
    filingDate: '2026-08-18',
    docId: '90000001',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/90000001.pdf',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].asset_type, 'ETF');
  assert.equal(rows[0].ticker, 'IVV');
});

test('[MF] marker maps to asset_type "Mutual Fund"', () => {
  const rows = parseHousePtrText({
    text: fixture('90000002'),
    member: 'Test Member',
    filingDate: '2026-08-18',
    docId: '90000002',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/90000002.pdf',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].asset_type, 'Mutual Fund');
});

// ── exchange type ───────────────────────────────────────────────────────────

test('House [E] rows normalize to type "exchange", not dropped', () => {
  const rows = parseHousePtrText({
    text: fixture('20035432'),
    member: 'August Lee Pfluger',
    filingDate: '2026-09-01',
    docId: '20035432',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035432.pdf',
  });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.type === 'Exchange' || r.type === 'exchange'));

  const normalized = normalizeAll(rows);
  assert.equal(normalized.length, rows.length, 'no exchange row should be skipped');
  assert.ok(normalized.every((t) => t.type === 'exchange'));
});

// ── scanned PDFs: placeholder row instead of silent [] ──────────────────────

test('scanned PDF (no text layer) emits one scanned_unparsed placeholder row', () => {
  const rows = parseHousePtrText({
    text: fixture('9116331'),
    member: 'Diana Harshbarger',
    filingDate: '2026-01-05',
    docId: '9116331',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116331.pdf',
  });

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.parse_status, 'scanned_unparsed');
  assert.equal(row.politician, 'Diana Harshbarger');
  assert.equal(row.filing_date, '2026-01-05');
  assert.equal(row.source_id, 'house_9116331_scanned');
  assert.equal(row.pdf_url, 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116331.pdf');
  assert.equal(row.transaction_date, '');
  assert.equal(row.asset_name, '');
  assert.equal(row.type, '');
});

test('scanned placeholder survives normalize with every transaction-detail field null', () => {
  const rows = parseHousePtrText({
    text: fixture('9116331'),
    member: 'Diana Harshbarger',
    filingDate: '2026-01-05',
    docId: '9116331',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116331.pdf',
  });
  const normalized = normalizeAll(rows);

  assert.equal(normalized.length, 1, 'placeholder row must not be dropped by normalize');
  const t = normalized[0];
  assert.equal(t.parse_status, 'scanned_unparsed');
  assert.equal(t.politician, 'Diana Harshbarger');
  assert.equal(t.filing_date, '2026-01-05');
  assert.equal(t.pdf_url, 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116331.pdf');
  assert.equal(t.transaction_date, null);
  assert.equal(t.ticker, null);
  assert.equal(t.asset_name, null);
  assert.equal(t.asset_type, null);
  assert.equal(t.type, null);
  assert.equal(t.amount_min, null);
  assert.equal(t.amount_max, null);
  assert.equal(t.owner, null);
});

// ── markers found but no rows matched: parse_failed placeholder ────────────
// Distinct from scanned_unparsed: markers WERE found (text layer exists,
// not a scanned/paper filing) but no row matched TX_RE — a parser gap, not
// a known source-format limitation. See DocID 20034999's real-world case,
// fixed above by extending TX_RE for single exact-dollar amounts; this
// fixture forces the same "zero rows extracted" branch with an amount shape
// no version of TX_RE recognizes, to test the placeholder itself.

test('markers found but no rows extracted emits one parse_failed placeholder row', () => {
  const rows = parseHousePtrText({
    text: fixture('90000003'),
    member: 'Test Member',
    filingDate: '2026-08-18',
    docId: '90000003',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/90000003.pdf',
  });

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.parse_status, 'parse_failed');
  assert.equal(row.politician, 'Test Member');
  assert.equal(row.filing_date, '2026-08-18');
  assert.equal(row.source_id, 'house_90000003_parse_failed');
  assert.equal(row.pdf_url, 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/90000003.pdf');
  assert.equal(row.transaction_date, '');
  assert.equal(row.asset_name, '');
});

test('parse_failed placeholder survives normalize with every transaction-detail field null', () => {
  const rows = parseHousePtrText({
    text: fixture('90000003'),
    member: 'Test Member',
    filingDate: '2026-08-18',
    docId: '90000003',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/90000003.pdf',
  });
  const normalized = normalizeAll(rows);

  assert.equal(normalized.length, 1, 'placeholder row must not be dropped by normalize');
  const t = normalized[0];
  assert.equal(t.parse_status, 'parse_failed');
  assert.equal(t.politician, 'Test Member');
  assert.equal(t.pdf_url, 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/90000003.pdf');
  assert.equal(t.transaction_date, null);
  assert.equal(t.ticker, null);
  assert.equal(t.asset_name, null);
  assert.equal(t.asset_type, null);
  assert.equal(t.type, null);
  assert.equal(t.amount_min, null);
  assert.equal(t.amount_max, null);
  assert.equal(t.owner, null);
});

test('normal (non-scanned) filing still gets parse_status "ok"', () => {
  const rows = parseHousePtrText({
    text: fixture('20035260'),
    member: 'Richard W. Allen',
    filingDate: '2026-08-18',
    docId: '20035260',
    pdfUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035260.pdf',
  });
  assert.ok(rows.every((r) => r.parse_status === 'ok'));

  const normalized = normalizeAll(rows);
  assert.ok(normalized.every((t) => t.parse_status === 'ok'));
});
