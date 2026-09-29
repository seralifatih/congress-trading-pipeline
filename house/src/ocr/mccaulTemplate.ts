// OCR template for the McCaul-style scanned House PTR: a dense table with NO
// per-row checkbox borders (unlike the Fleischmann/Harshbarger checkbox-grid
// templates surveyed alongside this one — see the Aşama 2 report), but the
// SAME underlying signal: amount is an "X" placed under one of 11 lettered
// columns (A-K), not typed dollar text. Whole-page OCR still collapses this
// grid into noise (checkbox/mark columns read as garbage tokens) exactly
// like every other House PTR scanned template tried so far — see this
// module's readAmountColumn for the pixel-density technique that reads it
// instead.
//
// Geometry is NOT hardcoded to pixel offsets: every column/row boundary is
// detected per-page via imageGrid.ts's gridline finder, because this
// template's row count varies a lot (6-30+ rows per page across sampled
// filings) and because even same-filer PDFs have shown DPI/margin drift
// across months (see report2_value_assessment.md's McCaul portrait-vs-
// landscape finding — this template only matches the landscape variant;
// portrait is a different, unimplemented layout and correctly falls through
// to the generic "no template recognized" path in ocr/index.ts).
import type { Canvas } from '@napi-rs/canvas';
import { extractGreyscale, findVerticalLines, findHorizontalLines, inkDensity } from './imageGrid.js';
import { ocrLine } from './textOcr.js';
import { ocrDateCell } from './dateOcr.js';
import { ocrOwnerCell, type OwnerCode } from './ownerOcr.js';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('ocr-mccaul-template');

// Expected page size at 300 DPI for the landscape variant this template
// covers (792x610pt source -> 3300x2544px). +/-40px tolerance absorbs minor
// DPI rounding without accidentally matching the portrait variant (which is
// ~2520x3260px — nowhere close).
const EXPECTED_WIDTH = 3300;
const EXPECTED_HEIGHT = 2544;
const SIZE_TOLERANCE = 40;

export function matchesTemplate(widthPx: number, heightPx: number): boolean {
  return (
    Math.abs(widthPx - EXPECTED_WIDTH) <= SIZE_TOLERANCE &&
    Math.abs(heightPx - EXPECTED_HEIGHT) <= SIZE_TOLERANCE
  );
}

const AMOUNT_COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as const;
export type AmountColumn = (typeof AMOUNT_COLUMNS)[number];

const TYPE_COLUMNS = ['Purchase', 'Sale', 'Exchange'] as const;
export type TypeColumn = (typeof TYPE_COLUMNS)[number];

export interface OcrRow {
  ownerCode: OwnerCode | null; // null if unreadable/no majority — see ownerOcr.ts, never guessed
  assetName: string;
  type: TypeColumn | null;
  transactionDateRaw: string; // '' if unreadable — see dateOcr.ts, never guessed
  notificationDateRaw: string; // '' if unreadable — see dateOcr.ts, never guessed
  amountColumn: AmountColumn | null;
  amountConfidence: number; // 0-1, margin between top and runner-up column density
  textConfidence: number; // 0-100, mean OCR confidence for this row's text crops
}

interface ColumnLayout {
  ownerLeft: number;
  ownerRight: number;
  assetLeft: number;
  assetRight: number;
  typeLefts: number[]; // 4 boundaries -> 3 cells (Purchase/Sale/Exchange)
  txDateLeft: number;
  txDateRight: number;
  notifDateLeft: number;
  notifDateRight: number;
  amountLefts: number[]; // 12 boundaries -> 11 cells (A-K)
}

// Locates the table's column boundaries by scanning a tall vertical strip
// near the top of the data rows (below the "Example" header row, which is
// present on every page and gives a reliably ruled reference band even on a
// page whose real data starts a row or two lower). Returns null if the
// expected number of columns isn't found — the caller treats that as
// "template didn't match this page" rather than guessing.
function findColumnLayout(image: Canvas, tableTop: number, probeHeight: number): ColumnLayout | null {
  const fullWidth = image.width;
  const region = extractGreyscale(image, 0, tableTop, fullWidth, probeHeight);
  const allLines = findVerticalLines(region, 0);

  // The amount grid (A-K) is the rightmost cluster of 12 evenly-spaced lines
  // (~65-75px apart at 300 DPI). Find it by scanning from the right for a
  // run of lines with consistent small spacing.
  const sorted = [...allLines].sort((a, b) => a - b);
  let amountLefts: number[] = [];
  for (let start = 0; start < sorted.length; start++) {
    const run = [sorted[start]!];
    for (let i = start + 1; i < sorted.length; i++) {
      const gap = sorted[i]! - run[run.length - 1]!;
      if (gap >= 55 && gap <= 85) run.push(sorted[i]!);
      else break;
    }
    if (run.length >= 12) { amountLefts = run.slice(0, 12); break; }
  }
  if (amountLefts.length !== 12) {
    log.debug(`findColumnLayout: expected 12 amount-grid lines, found ${amountLefts.length}`);
    return null;
  }

  // Type column (Purchase/Sale/Exchange): 3 cells, ~70-80px each, ending
  // right before the date columns start. Look for a run of 4 lines
  // immediately left of the date columns.
  //
  // Date columns: 2 cells, wider (~230-280px each) than type/amount cells.
  // The date columns' RIGHT boundary is the amount grid's own left boundary
  // (amountLefts[0]) — a gridline shared between the two column groups, not
  // a separate line to rediscover. Find the 2-line run (txDateLeft,
  // notifDateLeft = txDateRight) immediately left of amountLefts[0] with
  // that wider spacing, then treat amountLefts[0] as notifDateRight.
  const beforeAmount = sorted.filter((x) => x < amountLefts[0]! - 100);
  let dateLefts: number[] = [];
  for (let start = 0; start < beforeAmount.length; start++) {
    const run = [beforeAmount[start]!];
    for (let i = start + 1; i < beforeAmount.length; i++) {
      const gap = beforeAmount[i]! - run[run.length - 1]!;
      if (gap >= 200 && gap <= 320) run.push(beforeAmount[i]!);
      else break;
    }
    // Also require the run's last line to be a plausible distance from the
    // amount grid's own left boundary (i.e. it really is "notifDateLeft",
    // not some other unrelated pair of lines earlier in the row).
    if (run.length >= 2 && amountLefts[0]! - run[run.length - 1]! >= 200 && amountLefts[0]! - run[run.length - 1]! <= 320) {
      dateLefts = [run[0]!, run[run.length - 1]!, amountLefts[0]!];
      break;
    }
  }
  if (dateLefts.length !== 3) {
    log.debug(`findColumnLayout: expected 3 date-column lines, found ${dateLefts.length}`);
    return null;
  }

  const beforeDate = beforeAmount.filter((x) => x <= dateLefts[0]!);
  let typeLefts: number[] = [];
  for (let start = 0; start < beforeDate.length; start++) {
    const run = [beforeDate[start]!];
    for (let i = start + 1; i < beforeDate.length; i++) {
      const gap = beforeDate[i]! - run[run.length - 1]!;
      if (gap >= 55 && gap <= 90) run.push(beforeDate[i]!);
      else break;
    }
    if (run.length >= 4 && run[3]! <= dateLefts[0]! + 5) { typeLefts = run.slice(0, 4); break; }
  }
  if (typeLefts.length !== 4) {
    log.debug(`findColumnLayout: expected 4 type-column lines, found ${typeLefts.length}`);
    return null;
  }

  // Owner code column: a narrow cell near the page's left margin, separate
  // from the wide asset-name column. Asset name spans from the owner
  // column's right edge to the type column's left edge.
  const beforeType = beforeDate.filter((x) => x < typeLefts[0]! - 200);
  if (beforeType.length < 1) {
    log.debug('findColumnLayout: no owner-code boundary found');
    return null;
  }
  const ownerRight = beforeType[beforeType.length - 1]!;
  const ownerLeft = beforeType.length >= 2 ? beforeType[beforeType.length - 2]! : Math.max(0, ownerRight - 200);

  return {
    ownerLeft,
    ownerRight,
    assetLeft: ownerRight,
    assetRight: typeLefts[0]!,
    typeLefts,
    txDateLeft: dateLefts[0]!,
    txDateRight: dateLefts[1]!,
    notifDateLeft: dateLefts[1]!,
    notifDateRight: dateLefts[2]!,
    amountLefts,
  };
}

// Locates data-row top/bottom boundaries below the header, by finding
// horizontal gridlines across the amount-grid column span (a narrower probe
// than the full page width avoids false hits from stray marks in the wide
// asset-name column).
function findRowBoundaries(image: Canvas, layout: ColumnLayout, searchTop: number, searchHeight: number): number[] {
  const probeWidth = layout.amountLefts[layout.amountLefts.length - 1]! - layout.amountLefts[0]!;
  const region = extractGreyscale(image, layout.amountLefts[0]!, searchTop, probeWidth, searchHeight);
  return findHorizontalLines(region, searchTop);
}

const CELL_INSET_X = 8;
const CELL_INSET_Y = 8;
const MIN_MARK_DENSITY = 0.03;

function readAmountColumn(image: Canvas, layout: ColumnLayout, rowTop: number, rowBottom: number): { column: AmountColumn | null; confidence: number } {
  const densities: number[] = [];
  for (let i = 0; i < AMOUNT_COLUMNS.length; i++) {
    const left = layout.amountLefts[i]! + CELL_INSET_X;
    const width = layout.amountLefts[i + 1]! - layout.amountLefts[i]! - CELL_INSET_X * 2;
    const top = rowTop + CELL_INSET_Y;
    const height = rowBottom - rowTop - CELL_INSET_Y * 2;
    if (width <= 0 || height <= 0) { densities.push(0); continue; }
    densities.push(inkDensity(extractGreyscale(image, left, top, width, height)));
  }

  const ranked = densities.map((d, i) => ({ col: AMOUNT_COLUMNS[i]!, d })).sort((a, b) => b.d - a.d);
  const [top, second] = ranked;
  if (!top || top.d < MIN_MARK_DENSITY) return { column: null, confidence: 0 };
  const confidence = second && second.d > 0 ? (top.d - second.d) / top.d : 1;
  return { column: top.col, confidence };
}

function readTypeColumn(image: Canvas, layout: ColumnLayout, rowTop: number, rowBottom: number): TypeColumn | null {
  const densities: number[] = [];
  for (let i = 0; i < TYPE_COLUMNS.length; i++) {
    const left = layout.typeLefts[i]! + CELL_INSET_X;
    const width = layout.typeLefts[i + 1]! - layout.typeLefts[i]! - CELL_INSET_X * 2;
    const top = rowTop + CELL_INSET_Y;
    const height = rowBottom - rowTop - CELL_INSET_Y * 2;
    if (width <= 0 || height <= 0) { densities.push(0); continue; }
    densities.push(inkDensity(extractGreyscale(image, left, top, width, height)));
  }
  const ranked = densities.map((d, i) => ({ col: TYPE_COLUMNS[i]!, d })).sort((a, b) => b.d - a.d);
  const top = ranked[0];
  if (!top || top.d < MIN_MARK_DENSITY) return null;
  return top.col;
}

// Extracts every data row from every page of a rasterized McCaul-template
// filing. Returns null if the column layout can't be found on the FIRST
// page (a strong signal this filing doesn't actually match this template
// despite passing the page-size check) — caller falls through to the
// generic "no template" placeholder path rather than emitting garbage rows.
export async function extractMccaulRows(pages: { canvas: Canvas }[], filingYear: number): Promise<OcrRow[] | null> {
  const rows: OcrRow[] = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const { canvas: image } = pages[pageIndex]!;

    // The "Example: Mega Corp Common Stock" row is at a roughly fixed
    // vertical position near the top of every page's table — probe a
    // generous band there to find column boundaries independent of exactly
    // how many real rows precede/follow it.
    const layout = findColumnLayout(image, Math.round(image.height * 0.28), Math.round(image.height * 0.1));
    if (!layout) {
      if (pageIndex === 0) {
        log.debug('extractMccaulRows: column layout not found on page 1 — template mismatch');
        return null;
      }
      log.warn(`extractMccaulRows: column layout not found on page ${pageIndex + 1} — skipping page`);
      continue;
    }

    const tableSearchTop = Math.round(image.height * 0.28);
    const rowLines = findRowBoundaries(image, layout, tableSearchTop, image.height - tableSearchTop - 40);
    if (rowLines.length < 2) {
      log.warn(`extractMccaulRows: no row boundaries found on page ${pageIndex + 1} — skipping page`);
      continue;
    }

    // rowLines[0] is the line above the "Example" row (== header bottom);
    // rowLines[1] is the line below it (== first real data row's top). Real
    // data rows are every subsequent [rowLines[i], rowLines[i+1]] band.
    for (let i = 1; i < rowLines.length - 1; i++) {
      const rowTop = rowLines[i]!;
      const rowBottom = rowLines[i + 1]!;
      if (rowBottom - rowTop < 20) continue; // stray line artifact, not a real row

      const assetText = await ocrLine(image, layout.assetLeft + 4, rowTop, layout.assetRight - layout.assetLeft - 8, rowBottom - rowTop);

      if (!assetText.text.trim()) continue; // blank row (page has fewer rows than the ruled table)

      // Owner code, dates, and (via readTypeColumn/readAmountColumn below)
      // type/amount all use dedicated pipelines instead of the plain
      // ocrLine used for the asset name — see ownerOcr.ts/dateOcr.ts's
      // header comments for why plain PSM-7-no-preprocessing OCR proved
      // unreliable on these small, narrow cells specifically, and for why
      // both shell out to the native Tesseract CLI (one process per read)
      // instead of using tesseract.js. A result of null/'' means genuinely
      // unreadable after the 5-read majority vote; it is NEVER filled in
      // from a guess or a neighboring row.
      // Owner + both dates are independent of each other (separate cells,
      // separate CLI processes internally) — read them concurrently rather
      // than one-at-a-time. See ocrDateCell's comment for why this matters:
      // sequential CLI spawning made a full filing take over an hour.
      const rowLabel = `p${pageIndex + 1}_row${i}`;
      const [owner, txDate, notifDate] = await Promise.all([
        ocrOwnerCell(image, layout.ownerLeft + 4, rowTop, layout.ownerRight - layout.ownerLeft - 8, rowBottom - rowTop),
        ocrDateCell(image, layout.txDateLeft + 4, rowTop, layout.txDateRight - layout.txDateLeft - 8, rowBottom - rowTop, filingYear, `${rowLabel}_tx`),
        ocrDateCell(image, layout.notifDateLeft + 4, rowTop, layout.notifDateRight - layout.notifDateLeft - 8, rowBottom - rowTop, filingYear, `${rowLabel}_notif`),
      ]);

      const type = readTypeColumn(image, layout, rowTop, rowBottom);
      const amount = readAmountColumn(image, layout, rowTop, rowBottom);

      // Section-header row (e.g. "LLM FAMILY INVESTMENTS LP", "LINDA MAYS
      // MCCAUL 2010 DESCENDANT TRUST") — the filer's own sub-account
      // grouping label, printed as its own table row with an asset name but
      // no type/dates/amount cells filled in on the source form. Not a
      // failed OCR read: skip it rather than emitting a row that will
      // always fail validation. Owner is deliberately excluded from this
      // check: a section-header row and a genuine "self" (blank owner) row
      // are indistinguishable on owner alone.
      if (!type && !txDate.raw && !notifDate.raw && !amount.column) {
        continue;
      }

      const meanTextConf = assetText.confidence;

      rows.push({
        ownerCode: owner.code,
        assetName: assetText.text.trim(),
        type,
        transactionDateRaw: txDate.raw,
        notificationDateRaw: notifDate.raw,
        amountColumn: amount.column,
        amountConfidence: amount.confidence,
        textConfidence: meanTextConf,
      });
    }
  }

  return rows;
}
