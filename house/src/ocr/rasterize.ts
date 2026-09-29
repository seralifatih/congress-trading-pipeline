// PDF page -> rendered Canvas, using pdfjs-dist (rendering) + @napi-rs/canvas
// (the <canvas> pdfjs-dist needs, since Node has none natively). Both are
// pure npm installs — no native binary (no poppler/pdftoppm, no
// apt-get in the Dockerfile) — chosen specifically so the Apify Docker image
// doesn't need an OS-level change for this feature. See ocr/index.ts's
// top-of-file comment for the engine-choice writeup.
//
// Returns the rendered Canvas itself (not a re-decoded Image) — a
// @napi-rs/canvas Canvas is already a valid drawImage() source, and
// round-tripping it through toBuffer('image/png') + `new Image(); img.src =
// buf` turned out to silently produce a blank (fully transparent) image on
// the next drawImage call, even though width/height read back correctly —
// confirmed with a minimal repro. @napi-rs/canvas's own async loadImage()
// does decode correctly, but there's no reason to encode-then-decode a PNG
// here at all when the source canvas can be used directly.
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import path from 'path';
import { pathToFileURL } from 'url';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('ocr-rasterize');

const DPI = 300; // matches the manual prototype calibration in ocr/mccaulTemplate.ts
const PDF_POINTS_PER_INCH = 72;

// Some scanned-PTR PDFs embed their page image as JBIG2 (a common scanner
// output format) — pdfjs-dist's default JBIG2 decoder wants a WASM asset
// that isn't resolvable via plain package resolution in this build; without
// `wasmUrl` it logs a warning and falls back to a pure-JS decoder that still
// renders correctly (confirmed against a real scanned filing — see the OCR
// prototype's rasterize test). Pointing wasmUrl at the package's own bundled
// wasm/ directory silences the warning and lets it use the faster path when
// it can.
function pdfjsWasmUrl(): string {
  const wasmDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'wasm') + path.sep;
  return pathToFileURL(wasmDir).href;
}

let pdfjsLibPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
function loadPdfjs() {
  // pdfjs-dist's legacy build is ESM-only; dynamic import works from this
  // CJS-compiled-by-tsc output the same way the rest of the codebase already
  // relies on ESM-only deps (see package.json's "type": not set — tsc
  // target here compiles to the module format apify/actor-node expects).
  if (!pdfjsLibPromise) pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsLibPromise;
}

export interface RasterizedPage {
  pageNumber: number; // 1-based
  canvas: Canvas;
  widthPx: number;
  heightPx: number;
}

// Rasterizes every page of a PDF buffer to a 300 DPI canvas. Callers
// crop/OCR sub-regions directly from `canvas` via imageGrid.ts's
// extractGreyscale / textOcr.ts's ocrLine.
export async function rasterizePdf(pdfBuffer: Buffer): Promise<RasterizedPage[]> {
  const pdfjsLib = await loadPdfjs();
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    wasmUrl: pdfjsWasmUrl(),
  }).promise;

  const pages: RasterizedPage[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: DPI / PDF_POINTS_PER_INCH });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfjs-dist's
    // RenderParameters type expects a browser CanvasRenderingContext2D/
    // HTMLCanvasElement; napi-rs/canvas's types are API-compatible but not
    // those exact DOM types.
    await page.render({ canvasContext: ctx as any, canvas: canvas as any, viewport }).promise;

    pages.push({ pageNumber, canvas, widthPx: canvas.width, heightPx: canvas.height });
  }

  log.info(`Rasterized ${pages.length} page(s) at ${DPI} DPI`);
  return pages;
}
