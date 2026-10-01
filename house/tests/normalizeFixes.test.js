const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalize, normalizeAll } = require('../dist/transformer/normalize.js');
const { parseHousePtrText, stripGluedOwnerPrefix } = require('../dist/parser/housePdfParser.js');
const { collapseRepeatedTokens, normalizeNameCase } = require('../dist/utils/names.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function row(overrides = {}) {
  return {
    politician: 'Test Member', transaction_date: '08/05/2026', filing_date: '2026-08-12', ticker: '',
    asset_name: 'Some Company', asset_type: 'Stock', type: 'Purchase', amount: '$1,001 - $15,000', owner: 'self',
    source_id: 'house_1_0', filing_id: '1', filing_type: 'original', parse_status: 'ok', pdf_url: 'x',
    ocr_confidence: null, raw_json: {}, ...overrides,
  };
}

// ─── D: names ─────────────────────────────────────────────────────────────────
// Cause of "Scott Scott Franklin": it is IN the source. The 2026 House index
// (2026FD.xml) has <First>Scott Scott</First><Last>Franklin</Last> for both of
// his PTRs (DocIDs 20034050, 20035450); houseFetcher.memberName joins
// First+Last+Suffix verbatim. (The index also has <First>John John</First>
// for another member.) So it is not a parser bug; the doubled token is
// collapsed in normalize and politician_raw keeps what the source printed.

test('collapseRepeatedTokens drops a token repeated back-to-back, case-insensitively, and nothing else', () => {
  assert.equal(collapseRepeatedTokens('Scott Scott Franklin'), 'Scott Franklin');
  assert.equal(collapseRepeatedTokens('John John Rose'), 'John Rose');
  assert.equal(collapseRepeatedTokens('scott Scott Franklin'), 'scott Franklin');
  assert.equal(collapseRepeatedTokens('April McClain Delaney'), 'April McClain Delaney');
  assert.equal(collapseRepeatedTokens('Richard W. Allen'), 'Richard W. Allen');
});

test('normalize: politician collapsed, politician_raw verbatim (also on placeholders)', () => {
  const t = normalize(row({ politician: 'Scott Scott Franklin' }));
  assert.equal(t.politician, 'Scott Franklin');
  assert.equal(t.politician_raw, 'Scott Scott Franklin');
  const ph = normalize(row({ politician: 'Scott Scott Franklin', parse_status: 'scanned_unparsed', asset_name: '' }));
  assert.equal(ph.politician, 'Scott Franklin');
  assert.equal(ph.politician_raw, 'Scott Scott Franklin');
  assert.equal(ph.filing_date, '2026-08-12');
  assert.equal(ph.member_bioguide_id, null);
});

test('mixed-case House names are otherwise untouched; ALL-CAPS is re-cased like the Senate actor', () => {
  assert.equal(normalize(row({ politician: 'Charles J. "Chuck" Fleischmann' })).politician, 'Charles J. "Chuck" Fleischmann');
  assert.equal(normalizeNameCase('DONALD STERNOFF BEYER JR'), 'Donald Sternoff Beyer Jr');
});

// ─── G: tickers (same rules as the Senate actor) ──────────────────────────────

test('"-- AMCR" -> AMCR; "COLPAL" (company-name abbreviation) -> null with asset_name kept', () => {
  assert.equal(normalize(row({ ticker: '-- AMCR' })).ticker, 'AMCR');
  const t = normalize(row({ ticker: 'COLPAL', asset_name: 'COLGATE PALMOLIVE LTD.' }));
  assert.equal(t.ticker, null);
  assert.equal(t.asset_name, 'COLGATE PALMOLIVE LTD.');
});

test('the hyphen in ROLLS-ROYCE is not a "XXXX - Company" delimiter; "EA - Electronic Arts" still extracts', () => {
  assert.equal(normalize(row({ asset_name: 'ROLLS-ROYCE HOLDINGS PLC ADR' })).ticker, null);
  assert.equal(normalize(row({ asset_name: 'EA - Electronic Arts Inc' })).ticker, 'EA');
});

test('legitimate tickers are untouched; blank / "--" / several tickers -> null', () => {
  for (const ticker of ['WWSYX', 'SDZNY', 'GOOGL', 'BRK.B', 'EA']) assert.equal(normalize(row({ ticker })).ticker, ticker);
  for (const ticker of ['', '--', ' -- ', 'N/A']) assert.equal(normalize(row({ ticker })).ticker, null);
  assert.equal(normalize(row({ ticker: 'AAPL MSFT' })).ticker, null);
});

// ─── F: null tickers are mostly not parse misses; the real miss is the owner code ──

test('non-tradable assets keep ticker null: treasuries, munis, private funds, bank notes', () => {
  for (const [asset_type, asset_name] of [
    ['Government Security', 'UNITED STATES TREAS SER AF- 2027; 4.125%; Due 10/31/2027'],
    ['Government Security', 'King Cnty Wash 4.00% 12/01/32'],
    ['Other', 'Oaktree Strategic Credit Fund Class S Common Stock'],
    ['Corporate Bond', 'Bank of Nova Scotia'],
  ]) assert.equal(normalize(row({ asset_type, asset_name })).ticker, null, asset_name);
});

// The real parse miss behind part of that list: the PDF prints the owner
// column (SP / DC / JT) with NO separator before the asset name, and the old
// stripper only handled "Word" case ("SPApollo"), so all-caps and
// digit/dot/lowercase-leading names kept the code in asset_name and the row
// got owner "self" instead of joint/spouse/child.

test('stripGluedOwnerPrefix with a ticker: strips only when the remainder starts with the ticker\'s letter and the code does not', () => {
  assert.deepEqual(stripGluedOwnerPrefix('DCBWX Technologies, Inc. Common Stock', 'BWXT'), { name: 'BWX Technologies, Inc. Common Stock', ownerCode: 'DC' });
  assert.deepEqual(stripGluedOwnerPrefix('DCC.H. Robinson Worldwide, Inc. - Common Stock', 'CHRW'), { name: 'C.H. Robinson Worldwide, Inc. - Common Stock', ownerCode: 'DC' });
  assert.deepEqual(stripGluedOwnerPrefix('SPe.l.f. Beauty, Inc. Common Stock', 'ELF'), { name: 'e.l.f. Beauty, Inc. Common Stock', ownerCode: 'SP' });
  assert.deepEqual(stripGluedOwnerPrefix('SPJP Morgan Chase & Co. Common Stock', 'JPM'), { name: 'JP Morgan Chase & Co. Common Stock', ownerCode: 'SP' });
  assert.deepEqual(stripGluedOwnerPrefix('JTNESTLE S.A S/ADR', 'NSRGY'), { name: 'NESTLE S.A S/ADR', ownerCode: 'JT' });
});

test('stripGluedOwnerPrefix leaves names that really start with SP/DC/JT alone', () => {
  assert.equal(stripGluedOwnerPrefix('SPX Technologies, Inc. Common Stock', 'SPXC'), null);
  assert.equal(stripGluedOwnerPrefix('SPDR Gold Shares', 'GLD'), null);
  assert.equal(stripGluedOwnerPrefix('DCP Midstream, LP', 'DCP'), null);
  assert.equal(stripGluedOwnerPrefix('JTEKT Corporation', 'JTEKY'), null);
  assert.equal(stripGluedOwnerPrefix('SP Plus Corporation', 'SP'), null);
});

test('stripGluedOwnerPrefix without a ticker strips only JT; SP/DC are ambiguous (SPRINGFIELD, DC WATER) and kept', () => {
  assert.deepEqual(stripGluedOwnerPrefix('JTCADDO CNTY OKLA GOVERNMENTAL BLDG 05.00000% 09/01/2030', ''), { name: 'CADDO CNTY OKLA GOVERNMENTAL BLDG 05.00000% 09/01/2030', ownerCode: 'JT' });
  assert.equal(stripGluedOwnerPrefix('SPRINGFIELD TWP SCH DIST PA GO', ''), null);
  assert.equal(stripGluedOwnerPrefix('SPALPHAKEYS BLACKSTONE LIFE SCIENCES VI LP', ''), null);
  assert.equal(stripGluedOwnerPrefix('DC WTR & SWR AUTH', ''), null);
});

test('real PTR 20035134 (Kevin Hern): 14 rows, all joint, asset names clean, tickers kept', () => {
  const rows = normalizeAll(parseHousePtrText({ text: fixture('20035134.txt'), member: 'Kevin Hern', filingDate: '2026-08-05', docId: '20035134', pdfUrl: 'x' }));
  assert.equal(rows.length, 14);
  assert.ok(rows.every((r) => r.owner === 'joint'));
  assert.ok(rows.every((r) => !/^JT/.test(r.asset_name)));
  assert.equal(rows[0].asset_name, 'CADDO CNTY OKLA GOVERNMENTAL BLDG 05.00000% 09/01/2030');
  assert.equal(rows[0].ticker, null);
  assert.equal(rows[1].ticker, 'CMCSA');
  assert.equal(rows[1].asset_name, 'Comcast Corporation - Class A Common Stock');
});

test('real PTR 20035118 (April McClain Delaney): DC rows -> child, DCBWX/DCC.H. names repaired', () => {
  const rows = normalizeAll(parseHousePtrText({ text: fixture('20035118_head.txt'), member: 'April McClain Delaney', filingDate: '2026-08-01', docId: '20035118', pdfUrl: 'x' }));
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((r) => r.owner === 'child'));
  assert.ok(rows.some((r) => r.asset_name === 'BWX Technologies, Inc. Common Stock' && r.ticker === 'BWXT'));
  assert.ok(rows.some((r) => r.asset_name.startsWith('C.H. Robinson') && r.ticker === 'CHRW'));
  assert.ok(rows.every((r) => !/^DC/.test(r.asset_name)));
});

test('real PTR 20035489 (Sheri Biggs): "SPApollo"/"SPBank" strip as before; ticker-less all-caps "SPALPHAKEYS" is a documented residual', () => {
  const rows = normalizeAll(parseHousePtrText({ text: fixture('20035489.txt'), member: 'Sheri Biggs', filingDate: '2026-09-09', docId: '20035489', pdfUrl: 'x' }));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.owner), ['self', 'spouse', 'spouse', 'spouse']);
  assert.equal(rows[0].asset_name.startsWith('SPALPHAKEYS'), true, 'known limitation: cannot tell SP from the name without a ticker');
  assert.equal(rows[1].asset_name.startsWith('Apollo Debt Solutions'), true);
});

// ─── Exchange rows (type code E) have ONE asset — no given/received split ────
// Unlike Senate ("<given> (Exchanged) <received> (Received)" + a two-slot ticker
// cell), the House PDF prints a single asset per exchange row: the asset
// acquired, with its own ticker in the "(TICKER) [ST]" marker. The other side of
// the swap exists only in the free-text "D:" description. So House rows get no
// received_ticker / received_asset_name. Real PTRs: 20034960 (Dingell, spinoff
// HON -> HONAV) and 20035013 (Hern, XOM / HONAV).

test('real PTR 20035013 (Hern): exchange rows carry the single asset and its own ticker; there is no received_* data', () => {
  const rows = normalizeAll(parseHousePtrText({ text: fixture('20035013.txt'), member: 'Kevin Hern', filingDate: '2026-07-06', docId: '20035013', pdfUrl: 'x' }));
  const ex = rows.filter((r) => r.type === 'exchange');
  assert.equal(ex.length, 3);
  assert.ok(ex.every((r) => r.owner === 'joint'));
  assert.deepEqual([...new Set(ex.map((r) => r.ticker))].sort(), ['HONAV', 'XOM']);
  const xom = ex.find((r) => r.ticker === 'XOM');
  assert.equal(xom.asset_name, 'Exxon Mobil Corporation Common Stock');
  assert.ok(ex.every((r) => r.received_ticker === undefined && r.received_asset_name === undefined));
});

test('real PTR 20034960 (Dingell): the exchanged-from asset (HON) appears only in the description, never in the row', () => {
  const rows = normalizeAll(parseHousePtrText({ text: fixture('20034960.txt'), member: 'Debbie Dingell', filingDate: '2026-07-06', docId: '20034960', pdfUrl: 'x' }));
  const ex = rows.filter((r) => r.type === 'exchange');
  assert.equal(ex.length, 2);
  assert.ok(ex.every((r) => r.ticker === 'HONAV'));
  assert.equal(ex[0].asset_name, 'Honeywell Aerospace Inc. - Common Stock');
  assert.ok(ex.every((r) => !('received_ticker' in r)));
});

// ─── Wrapped "D:" descriptions must not leak into the next row's asset_name ───
// Real PTR 20034960 (Dingell): the first HONAV row's description is
//   "D : Asset acquired when certain Honeywell International Inc. (HON) shares were exchanged for Honeywell"
//   "Aerospace Inc. (HONAV) shares due to a spinoff."
// (101 chars, so the PDF wraps it). The wrapped second line sits between that
// comment and the NEXT row's asset name, and used to be glued onto it:
//   "Aerospace Inc. (HONAV) shares due to a spinoff. Honeywell Aerospace Inc. - Common Stock".

test('real PTR 20034960 (Dingell): both HONAV exchange rows are named "Honeywell Aerospace Inc. - Common Stock"', () => {
  const rows = normalizeAll(parseHousePtrText({ text: fixture('20034960.txt'), member: 'Debbie Dingell', filingDate: '2026-07-06', docId: '20034960', pdfUrl: 'x' }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.asset_name), ['Honeywell Aerospace Inc. - Common Stock', 'Honeywell Aerospace Inc. - Common Stock']);
  assert.deepEqual(rows.map((r) => r.ticker), ['HONAV', 'HONAV']);
  assert.ok(rows.every((r) => r.type === 'exchange'));
  assert.deepEqual(rows.map((r) => r.amount_min), [50001, 15001], 'amounts/dates untouched');
});

test('no real fixture yields an asset_name containing description prose', () => {
  const dir = path.join(__dirname, 'fixtures');
  for (const f of fs.readdirSync(dir).filter((n) => /^\d+.*\.txt$/.test(n))) {
    const rows = normalizeAll(parseHousePtrText({ text: fs.readFileSync(path.join(dir, f), 'utf8'), member: 'X', filingDate: '2026-01-01', docId: f, pdfUrl: 'x' }));
    for (const r of rows) {
      if (r.asset_name === null) continue; // placeholder
      assert.doesNotMatch(r.asset_name, /due to a spinoff|were exchanged|Asset acquired|investment decisions|delegated to/i, `${f}: ${r.asset_name}`);
    }
  }
});

test('a wrapped description that ends a filing (Bresnahan 20035216, 3-line D:) does not touch asset names either', () => {
  const rows = normalizeAll(parseHousePtrText({ text: fixture('20035216.txt'), member: 'Rob Bresnahan', filingDate: '2026-08-12', docId: '20035216', pdfUrl: 'x' }));
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => !/advisor|delegated/i.test(r.asset_name)));
});

test('the other real fixtures parse exactly as before the wrap fix (Hern 20035013 / 20035134, Delaney, Biggs)', () => {
  const hern = normalizeAll(parseHousePtrText({ text: fixture('20035013.txt'), member: 'Kevin Hern', filingDate: '2026-07-06', docId: '20035013', pdfUrl: 'x' }));
  assert.ok(hern.every((r) => ['Exxon Mobil Corporation Common Stock', 'Honeywell Aerospace Inc. - Common Stock'].includes(r.asset_name)));
  const hern2 = normalizeAll(parseHousePtrText({ text: fixture('20035134.txt'), member: 'Kevin Hern', filingDate: '2026-08-05', docId: '20035134', pdfUrl: 'x' }));
  assert.equal(hern2.length, 14);
  assert.equal(hern2[0].asset_name, 'CADDO CNTY OKLA GOVERNMENTAL BLDG 05.00000% 09/01/2030');
});

// Safety guard: a comment line that happens to fill the line width but does NOT
// wrap must not eat the next row's asset name.
test('a full-width comment line followed directly by a one-line asset name keeps that name', () => {
  const longComment = 'D          : ' + 'x'.repeat(100); // >= 95 chars, nothing wraps after it
  const text = [
    'IDOwnerAssetTransaction',
    'Type',
    'Alpha Corp (AAA) [ST]',
    'P07/01/202607/02/2026$1,001 - $15,000',
    'F      S     : New',
    longComment,
    'Beta Corp (BBB) [ST]',
    'P07/03/202607/04/2026$1,001 - $15,000',
    'F      S     : New',
  ].join('\n');
  const rows = parseHousePtrText({ text, member: 'X', filingDate: '2026-07-10', docId: 'g', pdfUrl: 'x' });
  assert.deepEqual(rows.map((r) => r.asset_name), ['Alpha Corp', 'Beta Corp']);
});
