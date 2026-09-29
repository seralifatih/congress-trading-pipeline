const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { attemptOcr, terminateOcrWorker } = require('../dist/ocr/index.js');
const { matchesTemplate } = require('../dist/ocr/mccaulTemplate.js');
const { AMOUNT_COLUMN_RANGES } = require('../dist/ocr/amountRanges.js');

// -- Template page-size matching (fast, no rendering/OCR) --------------------

test('matchesTemplate accepts the McCaul landscape page size', () => {
  assert.equal(matchesTemplate(3300, 2544), true);
});

test('matchesTemplate accepts small DPI-rounding drift', () => {
  assert.equal(matchesTemplate(3310, 2540), true);
});

test('matchesTemplate rejects the portrait variant seen on some McCaul pages/filings', () => {
  // See ocr/mccaulTemplate.ts's comment: a stray portrait page (~2544x3300)
  // appears within some otherwise-landscape McCaul filings (confirmed on a
  // real filing, DocID 9116211 page 2) -- this must NOT match, or the
  // extractor will try to read a landscape column layout off a portrait
  // page and either crash or (worse) silently misread it.
  assert.equal(matchesTemplate(2544, 3300), false);
});

test('matchesTemplate rejects an unrelated page size', () => {
  assert.equal(matchesTemplate(1000, 1000), false);
});

// -- Amount bracket table -----------------------------------------------------
// Read directly off the McCaul form's own column headers ("$1 000-$15 000",
// etc. -- note: $1,000 not $1,001, unlike the typed-PDF template's brackets).

test('amount column ranges cover A through J with no gaps or overlaps', () => {
  const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  for (const c of cols) assert.ok(AMOUNT_COLUMN_RANGES[c], `missing range for column ${c}`);
  assert.equal(AMOUNT_COLUMN_RANGES.A.min, 1_000);
  assert.equal(AMOUNT_COLUMN_RANGES.A.max, 15_000);
  assert.equal(AMOUNT_COLUMN_RANGES.J.min, 50_000_001);
  assert.equal(AMOUNT_COLUMN_RANGES.J.max, null); // "Over $50,000,000" -- unbounded
});

test('column K (spouse/dependent-child flag) is not an amount bracket', () => {
  assert.equal(AMOUNT_COLUMN_RANGES.K, undefined);
});

// -- Integration: real single-page fixture through the full attemptOcr path -
// Fixture is page 1 of a real McCaul filing (DocID 9116211, filed
// 2026-07-08), trimmed to one page to keep the fixture small and the test
// fast -- the full 6-page filing includes a stray portrait page (page 2,
// see matchesTemplate test above) that intentionally gets skipped, and
// running all 6 pages through real OCR takes several minutes, too slow for
// a test run. This one page alone is a meaningful integration check: real
// rasterization, real gridline detection, real tesseract.js OCR, real
// validation.
//
// IMPORTANT: this test does NOT assert result.succeeded === true. Real
// tesseract.js OCR on this page has occasionally misread a single date
// field on one row (out of ~25) across repeated runs during development --
// not always the same row, small run-to-run non-determinism in the OCR
// engine itself. That's exactly the scenario the all-or-nothing policy
// exists to catch (see ocr/index.ts): reject the whole page/filing rather
// than emit a partially-wrong row. So this test asserts the STRUCTURE is
// always correct (matched; and when it succeeds, the known-correct values
// for row 0) rather than asserting a specific pass/fail outcome that would
// make the test itself flaky.

test('McCaul fixture (DocID 9116211, page 1): template matches and OCR runs end-to-end', async () => {
  const pdfPath = path.join(__dirname, 'fixtures', '9116211_page1.pdf');
  const buffer = fs.readFileSync(pdfPath);

  const result = await attemptOcr(
    buffer,
    'Michael T. McCaul',
    '2026-07-08',
    '9116211',
    'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116211.pdf',
  );

  assert.equal(result.matched, true, 'page size must match the McCaul template');

  if (result.succeeded) {
    assert.ok(result.rows.length >= 20, `expected at least 20 rows on page 1, got ${result.rows.length}`);

    // Spot-check row 0: "FID ADV FLOATING RATE HIGH INCOME Z", Purchase,
    // column F ($500,001-$1,000,000), 06/26/2026 -> 07/05/2026 -- verified
    // by eye against the source PDF image during development. This row's
    // OCR has read cleanly on every run so far (unlike row 3's date, which
    // sometimes drops a character -- see the module comment above).
    const first = result.rows[0];
    assert.equal(first.parse_status, 'ocr');
    assert.match(first.asset_name, /FID ADV FLOATING RATE HIGH INCOME/);
    assert.equal(first.type, 'Purchase');
    assert.equal(first.amount, '$500001 - $1000000');
    assert.equal(first.transaction_date, '2026-06-26');
    assert.equal(first.owner, 'spouse');
    assert.ok(first.ocr_confidence !== null && first.ocr_confidence > 0);
    assert.equal(first.ticker, '', 'this template has no ticker field -- never guessed from asset_name');

    const sourceIds = new Set(result.rows.map((r) => r.source_id));
    assert.equal(sourceIds.size, result.rows.length, 'source_id must be unique per row');
    for (const row of result.rows) assert.equal(row.parse_status, 'ocr');
  } else {
    // Rejected by the all-or-nothing policy -- acceptable as long as the
    // rejection is small-scale OCR noise, not systemic template breakage.
    // rows is empty by contract when succeeded is false (see ocr/index.ts).
    assert.equal(result.rows.length, 0, 'a rejected filing must not emit partial rows');
  }
});

test('McCaul fixture page 1: successful OCR rows always normalize cleanly', async () => {
  const { normalizeAll } = require('../dist/transformer/normalize.js');
  const pdfPath = path.join(__dirname, 'fixtures', '9116211_page1.pdf');
  const buffer = fs.readFileSync(pdfPath);

  const result = await attemptOcr(
    buffer,
    'Michael T. McCaul',
    '2026-07-08',
    '9116211',
    'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116211.pdf',
  );

  if (result.succeeded) {
    const normalized = normalizeAll(result.rows);
    assert.equal(normalized.length, result.rows.length, 'no OCR row should be dropped by normalize');
    for (const t of normalized) {
      assert.equal(t.parse_status, 'ocr');
      assert.ok(t.amount_min !== null);
      assert.ok(t.ocr_confidence !== null);
    }
  }

  // terminate the shared tesseract.js worker so the test process can exit
  // promptly instead of relying on the runner's own timeout.
  await terminateOcrWorker();
});

// -- Integration: the FULL 6-page filing, not just page 1 --------------------
//
// The page-1-only fixture above hides a real, known defect: Tesseract has a
// residual, low-frequency (~4/111 rows) but genuine misread of the printed
// digit "2" as "7" in certain date cells on pages 4-6 of this filing --
// confirmed legible to a human eye, confirmed wrong at every tested
// upscale/threshold/PSM/OEM combination (see the investigation this test was
// added from). Page 1 alone happens not to trigger it, so a page-1-only test
// suite could pass indefinitely while the real 6-page filing keeps failing
// end to end. This test uses the full filing so that reality is visible in
// CI, not just in ad-hoc manual runs.
//
// It currently asserts REJECTION (succeeded === false), matching the actual,
// current behavior of the pipeline on this real filing -- this is not the
// desired end state, just the accurately-recorded current one. The
// all-or-nothing policy is doing exactly its job here: rejecting a filing
// with 4 wrong date reads rather than emitting them as if they were
// confirmed data. If a future fix (a different OCR engine, a template-
// specific correction, etc.) gets this filing passing, this test's
// expectation must be updated to match -- silently leaving it pinned to
// "always rejects" would hide a regression the same way the page-1 fixture
// hid this defect.
//
// Gated behind RUN_SLOW_TESTS=1: this one test takes ~90-100s (full 6-page
// rasterize + real CLI OCR on every date/owner cell), which would roughly
// triple the whole suite's runtime otherwise. Skipped by default so the
// normal `npm test` stays fast; run `RUN_SLOW_TESTS=1 npm test` (or target
// this file directly) to exercise it, e.g. after touching anything under
// src/ocr/.
const slowTest = process.env['RUN_SLOW_TESTS'] === '1' ? test : test.skip;
slowTest('McCaul fixture (DocID 9116211, FULL 6 pages): known residual OCR defect causes rejection', async () => {
  const pdfPath = path.join(__dirname, 'fixtures', '9116211_full.pdf');
  const buffer = fs.readFileSync(pdfPath);

  const result = await attemptOcr(
    buffer,
    'Michael T. McCaul',
    '2026-07-08',
    '9116211',
    'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116211.pdf',
  );

  assert.equal(result.matched, true, 'page size must match the McCaul template');

  // As of this test's writing: rejected, due to ~4/111 rows with an
  // unreadable/misread date (see the module-level comment above). If this
  // ever flips to true, that's good news -- update this assertion (and the
  // comment) rather than leaving a stale expectation in place.
  assert.equal(result.succeeded, false, 'full filing currently fails validation -- see comment above; update this if a future fix resolves it');
  assert.equal(result.rows.length, 0, 'a rejected filing must not emit partial rows');

  await terminateOcrWorker();
});
