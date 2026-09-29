// Low-level image analysis shared by every OCR template: locate table
// gridlines by pixel density, and measure ink density inside a cell.
//
// Why gridline detection instead of hardcoded pixel offsets: this House PTR
// checkbox-grid form is ruled with real black lines at 300 DPI, and those
// lines are detectable as a near-continuous run of dark pixels across a
// column/row — far more reliable than reading approximate coordinates off a
// rendered image by eye (which doesn't survive even small DPI/margin drift
// between filings). See ocr/mccaulTemplate.ts for how this is used to find
// the amount-grid (A-K) and type (Purchase/Sale/Exchange) column boundaries
// on every page independently, rather than assuming one fixed layout.
import type { Canvas } from '@napi-rs/canvas';

export interface GreyscaleRegion {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// Reads a region's pixels directly off the source page canvas (no
// intermediate crop-canvas needed — getImageData already takes an offset)
// and returns its greyscale values as a flat [0,255] array.
export function extractGreyscale(source: Canvas, left: number, top: number, width: number, height: number): GreyscaleRegion {
  const ctx = source.getContext('2d');
  const { data } = ctx.getImageData(left, top, width, height);

  const grey = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!;
    grey[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { data: grey, width, height };
}

const DARK_THRESHOLD = 128;

// Collapses a sorted list of pixel indices into single "line center" values
// by averaging consecutive runs — a real gridline is a few pixels thick, not
// a mathematical single line.
function collapseRuns(indices: number[]): number[] {
  const collapsed: number[] = [];
  let runStart: number | null = null;
  let prev = -2;
  for (const idx of indices) {
    if (idx !== prev + 1) {
      if (runStart !== null) collapsed.push(Math.round((runStart + prev) / 2));
      runStart = idx;
    }
    prev = idx;
  }
  if (runStart !== null) collapsed.push(Math.round((runStart + prev) / 2));
  return collapsed;
}

// Finds vertical gridlines within a region: an x-column counts as a line
// when at least `minRunFraction` of its pixels (down the region's height)
// are dark. Returns line center x-coordinates, in the SAME coordinate space
// as `left` (i.e. already offset — callers don't need to add `left` back).
export function findVerticalLines(region: GreyscaleRegion, left: number, minRunFraction = 0.7): number[] {
  const { data, width, height } = region;
  const colDarkCount = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x]! < DARK_THRESHOLD) colDarkCount[x]!++;
    }
  }
  const hits: number[] = [];
  for (let x = 0; x < width; x++) {
    if (colDarkCount[x]! / height >= minRunFraction) hits.push(x);
  }
  return collapseRuns(hits).map((x) => x + left);
}

// Same as findVerticalLines but for horizontal (row-boundary) lines.
export function findHorizontalLines(region: GreyscaleRegion, top: number, minRunFraction = 0.7): number[] {
  const { data, width, height } = region;
  const rowDarkCount = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x]! < DARK_THRESHOLD) rowDarkCount[y]!++;
    }
  }
  const hits: number[] = [];
  for (let y = 0; y < height; y++) {
    if (rowDarkCount[y]! / width >= minRunFraction) hits.push(y);
  }
  return collapseRuns(hits).map((y) => y + top);
}

// Ink (dark-pixel) density of a region, as a 0-1 fraction. A drawn mark (X or
// checkmark) inside a cell inset from its border reads well above an empty
// cell's near-zero baseline — see ocr/mccaulTemplate.ts's readAmountColumn
// for the inset margin and the "top vs. runner-up" comparison this feeds.
export function inkDensity(region: GreyscaleRegion): number {
  let dark = 0;
  for (const px of region.data) if (px < DARK_THRESHOLD) dark++;
  return dark / region.data.length;
}
