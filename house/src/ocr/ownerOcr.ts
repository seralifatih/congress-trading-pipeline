// Targeted owner-cell OCR — the same upscale+binarize+whitelist+majority-
// vote architecture as dateOcr.ts, applied to the owner-code column
// (blank = self, "SP" = spouse, "DC" = dependent child, "JT" = joint — see
// the OWNER_CODES map below). Built after discovering the general-purpose
// per-row OCR path (textOcr.ts's ocrLine, no preprocessing) misreads this
// column too: a fixture row known to be "SP" read as "sr" at 30%
// confidence, deterministically, on every retry — not the OCR noise this
// was initially assumed to be (see the conversation this module was added
// in for how that assumption got caught and corrected). Same root cause
// class as the original date-cell problem: this column's cells are small
// (a couple of characters in a narrow box) and plain unrestricted PSM 7 OCR
// on the raw crop is simply unreliable at that size — not specific to
// dates.
//
// Uses the native Tesseract CLI (tesseractCli.ts), one process per read,
// same as dateOcr.ts — see that file's top comment and tesseractCli.ts for
// why: a byte-for-byte diagnosis proved tesseract.js itself misreads
// certain images the CLI reads correctly, given identical input bytes.
import type { Canvas } from '@napi-rs/canvas';
import { createCanvas } from '@napi-rs/canvas';
import { makeLogger } from '../utils/logger.js';
import { ocrImageBuffer } from './tesseractCli.js';

const log = makeLogger('ocr-owner');

const BORDER_INSET = 8; // same rationale as dateOcr.ts's BORDER_INSET

// Five configs, all at upscale=6 (varying only threshold) — see dateOcr.ts's
// READ_CONFIGS comment for why: measurement on the full McCaul filing found
// upscale=4 has a systematic (not random) ~18% misread rate on at least one
// digit shape, vs ~7.5% at upscale=6, so mixing scales biased votes toward
// the less reliable one instead of adding independence.
const READ_CONFIGS: { upscale: number; threshold: number }[] = [
  { upscale: 6, threshold: 100 },
  { upscale: 6, threshold: 120 },
  { upscale: 6, threshold: 140 },
  { upscale: 6, threshold: 160 },
  { upscale: 6, threshold: 180 },
];

// This template's owner column only ever contains these codes (per the
// form's own "SP / DC / JT" legend) or is blank (= self). Anything else
// Tesseract might offer is guaranteed noise — restricting the whitelist to
// exactly these letters is both a whitelist AND, combined with the shape
// check below, most of the validation.
const OWNER_WHITELIST = 'SPDCJT';

export type OwnerCode = 'self' | 'spouse' | 'child' | 'joint';
const OWNER_CODE_MAP: Record<string, OwnerCode> = {
  '': 'self',
  SP: 'spouse',
  DC: 'child',
  JT: 'joint',
};
const VALID_RAW_CODES = new Set(Object.keys(OWNER_CODE_MAP));

function isValidOwnerText(raw: string): boolean {
  return VALID_RAW_CODES.has(raw.trim().toUpperCase());
}

// Bilinear (smooth) upscale, then a separate binarize pass — see
// dateOcr.ts's upscaleAndBinarize for why: the previous hand-rolled
// nearest-neighbor upscale produced aliased edges that caused a
// reproducible, scale/threshold-independent digit misread (a "2" read as
// "7" at every one of 25 tested upscale/threshold combinations). Same fix
// applied here for consistency, even though the owner column's SPDCJT
// glyphs weren't specifically measured to have this defect — the aliasing
// mechanism isn't digit-specific.
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

export interface OwnerOcrResult {
  code: OwnerCode | null; // majority-agreed owner code, or null if unreadable/no majority
  raw: string; // the winning raw text ('' for self), '' with code null if no majority
  reads: string[]; // every individually-valid raw read this call produced (for logging/debugging)
}

// Runs the 5-read majority-vote pipeline against one owner cell, using a
// separate native Tesseract CLI process per read.
//
// IMPORTANT: an EMPTY cell (self) is a legitimate reading, not a failure —
// most rows on this form have no owner code at all. A read that comes back
// blank/whitespace-only counts as a valid "" vote, same as any other valid
// code.
export async function ocrOwnerCell(source: Canvas, left: number, top: number, width: number, height: number): Promise<OwnerOcrResult> {
  if (width <= 0 || height <= 0) return { code: null, raw: '', reads: [] };

  // Run all 5 reads concurrently — see dateOcr.ts's ocrDateCell for why
  // (sequential CLI process spawning made a full filing take over an hour).
  const results = await Promise.all(
    READ_CONFIGS.map(async ({ upscale, threshold }) => {
      const processed = upscaleAndBinarize(source, left, top, width, height, upscale, threshold);
      const buffer = processed.toBuffer('image/png');
      const text = (await ocrImageBuffer(buffer, { psm: 7, whitelist: OWNER_WHITELIST })).toUpperCase();
      return { upscale, threshold, text };
    }),
  );

  const validReads: string[] = [];
  for (const { upscale, threshold, text } of results) {
    if (isValidOwnerText(text)) {
      validReads.push(text);
    } else {
      log.debug(`ocrOwnerCell: upscale=${upscale} threshold=${threshold} produced "${text}" — not a valid owner code`);
    }
  }

  if (validReads.length === 0) {
    return { code: null, raw: '', reads: validReads };
  }

  // True majority of ALL configured reads (3 of 5), not just "more than the
  // runner-up among however many happened to be valid" — see dateOcr.ts's
  // ocrDateCell for the measured failure mode (2 consistently-wrong reads
  // out of 5 winning against 0 runner-up votes) this guards against.
  const counts = new Map<string, number>();
  for (const r of validReads) counts.set(r, (counts.get(r) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topValue, topCount] = ranked[0]!;
  const requiredVotes = Math.floor(READ_CONFIGS.length / 2) + 1;

  if (topCount >= requiredVotes) {
    return { code: OWNER_CODE_MAP[topValue]!, raw: topValue, reads: validReads };
  }

  log.debug(`ocrOwnerCell: no majority among valid reads [${validReads.join(', ')}] — treating cell as unreadable`);
  return { code: null, raw: '', reads: validReads };
}
