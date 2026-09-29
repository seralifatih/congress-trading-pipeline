// Targeted date-cell OCR — a dedicated, higher-effort path for just the two
// date columns, built after the general-purpose per-row OCR (textOcr.ts's
// ocrLine, PSM 7, no preprocessing) proved unreliable specifically on dates:
// ~5-8% of McCaul's date cells came back empty or with a dropped digit,
// while every other field (owner, asset name, type, amount) read cleanly.
// See report3_asama_a_production.md for the baseline numbers this module
// is trying to improve on, report4_date_ocr_iteration.md for the first
// iteration's findings (border-contamination and inset/upscale bugs, both
// fixed below), and tesseractCli.ts's header comment for why this module
// shells out to the native Tesseract CLI per read instead of using
// tesseract.js — a byte-for-byte diagnosis proved tesseract.js itself
// misreads specific images that the native CLI reads correctly, given the
// EXACT SAME input bytes.
//
// The approach, per cell:
//   1. Crop the date cell alone (already done by the caller).
//   2. Read it 5 times, each attempt using a DIFFERENT preprocessing
//      (upscale factor and/or binarization threshold — see READ_CONFIGS) so
//      the reads are independent enough that a misread specific to one
//      preprocessing doesn't repeat identically across all of them.
//   3. Each read: upscale (nearest-neighbor) + binarize + a SEPARATE
//      tesseract CLI process with PSM 7 + a whitelist restricted to
//      "0123456789/" + validate against BOTH a shape regex (MM/DD/YY(YY))
//      AND full calendar-value validation (month 1-12, day 1-31, a real
//      day-in-month, year within [filingYear-1, filingYear] — see
//      isValidCalendarDate). A read that fails either check does not enter
//      the vote.
//   4. Majority vote: a value needs a TRUE majority of all configured reads
//      (3 of 5), not just "more than the runner-up among however many
//      happened to be valid" — see the comment on requiredVotes below for
//      the specific measured failure mode this closes.
//   5. Never guess, never fall back to a neighboring row's date. An
//      unreadable cell returns '' and always propagates to a validation
//      failure and the all-or-nothing filing-level reject (see
//      ocr/index.ts) — the correct outcome when this module genuinely
//      could not establish a confident reading.
import type { Canvas } from '@napi-rs/canvas';
import { createCanvas } from '@napi-rs/canvas';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeLogger } from '../utils/logger.js';
import { ocrImageBuffer } from './tesseractCli.js';

const log = makeLogger('ocr-date');

// Diagnostic capture mode: when OCR_DEBUG_DUMP_DIR is set, every
// preprocessed date-cell PNG this module produces is written to disk with
// its SHA256 in the filename, alongside the exact text the OCR engine
// returned for it. This is what proved the tesseract.js defect (see the
// top-of-file comment) — kept as a permanent, off-by-default diagnostic
// tool rather than removed, in case a similar question comes up again
// (e.g. verifying the CLI itself stays reliable over time).
const DEBUG_DUMP_DIR = process.env['OCR_DEBUG_DUMP_DIR'];
let debugCallCounter = 0;

function debugDumpImage(label: string, buffer: Buffer, ocrText: string): void {
  if (!DEBUG_DUMP_DIR) return;
  mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  debugCallCounter++;
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${String(debugCallCounter).padStart(5, '0')}_${safeLabel}_${hash}.png`;
  writeFileSync(join(DEBUG_DUMP_DIR, fileName), buffer);
  const safeText = ocrText.replace(/\r?\n/g, '\\n');
  log.info(`OCR_DEBUG_DUMP: ${fileName} sha256=${hash} text="${safeText}"`);
}

// Root-caused bug #1 (Aşama A date-OCR iteration): even a few stray dark
// pixels from the table's own gridline/border at a crop's edge make PSM 7
// (and PSM 6) find ZERO text lines and return empty — confirmed with a
// side-by-side test: the exact same clean, legible "06/29/2026" crop OCR'd
// to "" with a border strip included, and correctly with it trimmed off.
// Fix: inset before upscale/binarize.
//
// Root-caused bug #2 (same iteration): a too-large inset (15px) combined
// with too-small an upscale (3x) left some rows' cropped text only ~26px
// tall pre-scale, thin enough that glyphs got distorted (a "6" misread as
// "G", digits merged into "20026" instead of "2026"). 8px inset + 4x
// upscale reads cleanly. Keep the inset MINIMAL: its only job is clearing
// the border line, not adding general margin.
const BORDER_INSET = 8;

// Five independent read configurations — different threshold values, all at
// upscale=6. Originally this mixed upscale=4 (3 configs) and upscale=6 (2
// configs), on the assumption that varying upscale factor adds independence
// the same way varying threshold does. Measurement on the full 111-row
// McCaul filing disproved that: upscale=4 has a systematic, NOT random,
// ~18% misread rate on the digit "2" in "2026" (reads it as "7" — same
// wrong answer every time at that scale, not noise a majority vote can
// average out), vs ~7.5% at upscale=6. Because 3 of 5 old configs used the
// worse scale, the majority vote often sided with the wrong digit or lacked
// a majority at all. Re-scaling an already-binarized image further doesn't
// fix it either — this is a genuine pixel-level glyph ambiguity at
// upscale=4, not a resolution problem solvable by upsampling afterward.
// Standardizing on upscale=6 (still varying threshold for independence)
// cut the failure rate substantially in testing. NOT a domain-knowledge
// digit-correction heuristic — this keeps the "never guess" policy intact
// by only changing which images get read, not how reads are interpreted.
const READ_CONFIGS: { upscale: number; threshold: number }[] = [
  { upscale: 6, threshold: 100 },
  { upscale: 6, threshold: 120 },
  { upscale: 6, threshold: 140 },
  { upscale: 6, threshold: 160 },
  { upscale: 6, threshold: 180 },
];

// MM/DD/YYYY, M/D/YYYY, MM/DD/YY, M/D/YY — the two formats seen across
// McCaul rows (some rows print a 2-digit year, most print 4).
const DATE_SHAPE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

// Full calendar validation, not just shape — catches a value that matches
// the regex but isn't a real date (month 13, day 32) or is a plausible-
// looking OCR misread that happens to still parse (e.g. "71/5/2026": shape-
// valid as month=71, day=5, year=2026, but month 71 doesn't exist). Year is
// constrained to [filingYear - 1, filingYear]: a PTR discloses a
// transaction that already happened and was already notified, both always
// within about a year of the filing itself in this dataset — a wildly
// different year is a strong misread signal, not a real edge case worth
// accommodating.
function isValidCalendarDate(raw: string, filingYear: number): boolean {
  const m = raw.match(DATE_SHAPE_RE);
  if (!m) return false;
  const month = parseInt(m[1]!, 10);
  const day = parseInt(m[2]!, 10);
  const yearRaw = m[3]!;
  const year = yearRaw.length === 2 ? 2000 + parseInt(yearRaw, 10) : parseInt(yearRaw, 10);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < filingYear - 1 || year > filingYear) return false;

  // Real day-in-month check (catches Feb 30, Apr 31, etc.) via JS Date
  // round-trip: constructing e.g. new Date(2026, 1, 30) rolls over to
  // March 2 rather than throwing, so verify the constructed date reports
  // back the same month/day we asked for.
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Normalizes a validated date string for vote comparison — "6/25/2026" and
// "06/25/2026" are the same date and must count as agreeing votes, not a
// 3-way split.
function normalizeForVote(raw: string): string {
  const m = raw.match(DATE_SHAPE_RE)!;
  const month = m[1]!.padStart(2, '0');
  const day = m[2]!.padStart(2, '0');
  const yearRaw = m[3]!;
  const year = yearRaw.length === 2 ? String(2000 + parseInt(yearRaw, 10)) : yearRaw;
  return `${month}/${day}/${year}`;
}

// Root-caused bug #3 (this iteration, discovered chasing what first looked
// like a concurrency regression): the hand-rolled nearest-neighbor upscale
// below was producing hard, aliased pixel-block edges on certain digit
// shapes — measured concretely on a "2026" that misread as "2076"/"7026" at
// EVERY tested upscale factor (4/6/8/10/12) and EVERY threshold, 25/25
// wrong, with the two wrong answers alternating by scale factor rather than
// converging. That ruled out "just scale it more". Switching to canvas's
// built-in bilinear interpolation (drawImage with imageSmoothingEnabled),
// which preserves the digit's curve instead of stair-stepping it, fixed
// this exact cell at every scale tested, and even fixed it with NO upscale
// at all — confirming the defect was the interpolation method, not
// resolution. Threshold is still applied as a separate pass after the
// smooth resize, not fused into it.
function upscaleAndBinarize(source: Canvas, rawLeft: number, rawTop: number, rawWidth: number, rawHeight: number, upscale: number, threshold: number): Canvas {
  const insetX = Math.min(BORDER_INSET, Math.floor(rawWidth / 4));
  const insetY = Math.min(BORDER_INSET, Math.floor(rawHeight / 4));
  const left = rawLeft + insetX;
  const top = rawTop + insetY;
  const width = rawWidth - insetX * 2;
  const height = rawHeight - insetY * 2;

  const outW = width * upscale;
  const outH = height * upscale;
  const scaled = createCanvas(outW, outH);
  const scaledCtx = scaled.getContext('2d');
  scaledCtx.imageSmoothingEnabled = true;
  scaledCtx.imageSmoothingQuality = 'high';
  scaledCtx.drawImage(source, left, top, width, height, 0, 0, outW, outH);

  const { data } = scaledCtx.getImageData(0, 0, outW, outH);
  const out = createCanvas(outW, outH);
  const outCtx = out.getContext('2d');
  const outImageData = outCtx.createImageData(outW, outH);

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const si = (oy * outW + ox) * 4;
      const r = data[si]!, g = data[si + 1]!, b = data[si + 2]!;
      const grey = 0.299 * r + 0.587 * g + 0.114 * b;
      const value = grey < threshold ? 0 : 255;

      const di = (oy * outW + ox) * 4;
      outImageData.data[di] = value;
      outImageData.data[di + 1] = value;
      outImageData.data[di + 2] = value;
      outImageData.data[di + 3] = 255;
    }
  }

  outCtx.putImageData(outImageData, 0, 0);
  return out;
}

export interface DateOcrResult {
  raw: string; // the majority-agreed, normalized MM/DD/YYYY string, or '' if unreadable
  reads: string[]; // every individually-valid read this call produced, in config order (for logging/debugging)
}

// Runs the 5-read majority-vote pipeline against one date cell, using a
// separate native Tesseract CLI process per read (see tesseractCli.ts's
// ocrImageBuffer and this file's top comment for why: tesseract.js itself
// was proven, byte-for-byte, to misread certain images the CLI reads
// correctly).
export async function ocrDateCell(source: Canvas, left: number, top: number, width: number, height: number, filingYear: number, debugLabel = 'cell'): Promise<DateOcrResult> {
  if (width <= 0 || height <= 0) return { raw: '', reads: [] };

  // The 5 reads are fully independent (different preprocessing, each its
  // own tesseract process via tesseractCli.ts) — run them concurrently
  // rather than one-at-a-time. Sequential CLI process spawning (one per
  // read x 2 date fields x 111 rows = 1110+ process launches for a single
  // McCaul filing) made a full extraction take over an hour; running each
  // cell's 5 reads in parallel cuts that by roughly 5x.
  const results = await Promise.all(
    READ_CONFIGS.map(async ({ upscale, threshold }) => {
      const processed = upscaleAndBinarize(source, left, top, width, height, upscale, threshold);
      const buffer = processed.toBuffer('image/png');
      const text = await ocrImageBuffer(buffer, { psm: 7, whitelist: '0123456789/' });
      debugDumpImage(`${debugLabel}_u${upscale}_t${threshold}`, buffer, text);
      return { upscale, threshold, text };
    }),
  );

  const validReads: string[] = [];
  for (const { upscale, threshold, text } of results) {
    if (isValidCalendarDate(text, filingYear)) {
      validReads.push(normalizeForVote(text));
    } else {
      log.debug(`ocrDateCell: upscale=${upscale} threshold=${threshold} produced "${text}" — fails shape or calendar validation`);
    }
  }

  if (validReads.length === 0) {
    return { raw: '', reads: validReads };
  }

  // Majority vote against the TOTAL configured read count (READ_CONFIGS.
  // length), not just against however many reads happened to be shape/
  // calendar-valid. A value needs strict majority of all attempts (e.g. 3
  // of 5) — not just "more than the runner-up among 2 valid reads out of
  // 5". This closes a real gap found by measurement: a row whose true date
  // is "7/5/2026" produced 3 invalid reads (correctly discarded) and 2
  // reads that both, coincidentally, misread "7" as "01" — "01/05/2026"
  // then won the old runner-up-only comparison (2 votes vs. 0 runner-up)
  // despite being wrong and despite only 2 of 5 total attempts agreeing on
  // it. Requiring a true majority of all configured reads (3 of 5) rejects
  // that case as unreadable instead of confidently returning a wrong date.
  const counts = new Map<string, number>();
  for (const r of validReads) counts.set(r, (counts.get(r) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topValue, topCount] = ranked[0]!;
  const requiredVotes = Math.floor(READ_CONFIGS.length / 2) + 1;

  if (topCount >= requiredVotes) {
    return { raw: topValue, reads: validReads };
  }

  log.debug(`ocrDateCell: top read "${topValue}" got ${topCount}/${READ_CONFIGS.length} votes (need ${requiredVotes}) among valid reads [${validReads.join(', ')}] — treating cell as unreadable`);
  return { raw: '', reads: validReads };
}
