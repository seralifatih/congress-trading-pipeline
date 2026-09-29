// Per-region text OCR via tesseract.js — used for the asset-name column
// only. Whole-page OCR collapses this form's checkbox/mark grid into noise
// (see ocr/index.ts's top comment) — the fix proven in the prototype is
// cropping a narrow band per field and running OCR on that crop alone with
// PSM 7 (treat as a single text line), which reads asset names cleanly.
//
// Date and owner cells use a DIFFERENT engine (the native Tesseract CLI —
// see dateOcr.ts/ownerOcr.ts/tesseractCli.ts) after a byte-for-byte
// diagnosis proved tesseract.js itself misreads certain images that the CLI
// reads correctly given identical input bytes — see tesseractCli.ts's
// header comment for the full story. This module's tesseract.js worker
// remains in use for asset names only, where no such defect was found
// (asset names are validated by nothing more than "non-empty," so a rare
// misread there doesn't trip the all-or-nothing filing-level reject the way
// a wrong date or owner code does — the risk profile is different enough
// not to warrant migrating this path too).
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { createWorker, type Worker } from 'tesseract.js';
import { makeLogger } from '../utils/logger.js';

const log = makeLogger('ocr-text');

let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng').then(async (w) => {
      // PSM 7 = "treat the image as a single text line" — matches how every
      // crop this module receives is already a single row's single field,
      // never a multi-line block.
      await w.setParameters({ tessedit_pageseg_mode: '7' as unknown as never });
      return w;
    });
  }
  return workerPromise;
}

// Call once when a pipeline run is finishing OCR work, so the actor process
// can exit cleanly (an open tesseract.js worker otherwise keeps the event
// loop alive).
export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

export interface OcrLineResult {
  text: string;
  confidence: number; // 0-100
}

export async function ocrLine(source: Canvas, left: number, top: number, width: number, height: number): Promise<OcrLineResult> {
  if (width <= 0 || height <= 0) return { text: '', confidence: 0 };

  const crop = createCanvas(width, height);
  const ctx = crop.getContext('2d');
  ctx.drawImage(source, -left, -top);
  const buffer = crop.toBuffer('image/png');

  const worker = await getWorker();
  try {
    const { data } = await worker.recognize(buffer);
    return { text: data.text, confidence: data.confidence };
  } catch (err) {
    log.warn(`ocrLine failed at (${left},${top},${width}x${height}): ${err instanceof Error ? err.message : String(err)}`);
    return { text: '', confidence: 0 };
  }
}
