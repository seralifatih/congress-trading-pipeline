// Native Tesseract CLI wrapper — one process per OCR call, replacing
// tesseract.js for date and owner cell reads (ownerOcr.ts, dateOcr.ts).
//
// WHY: byte-for-byte diagnosis (see the conversation this module was added
// in) proved tesseract.js itself — not our image preprocessing, not worker
// state, not coordinate drift — misreads certain cells. The exact PNG bytes
// tesseract.js fed for a cell that read as "71/5/2026" in the real
// 111-row pipeline were captured (SHA256-hashed), regenerated in complete
// isolation (identical hash, confirming byte-for-byte identical input), and
// STILL misread as "71/5/2026" by a freshly-created tesseract.js worker.
// The native Tesseract CLI (v5.4.0), given that exact same image file,
// read it correctly as "7/5/2026" — and the same held for every other
// disagreeing cell found in that pipeline run (3/3 checked). This is a
// defect specific to tesseract.js's WASM build, not to the Tesseract OCR
// engine itself or to our pipeline.
//
// This costs the Dockerfile change ocr/index.ts's original engine-choice
// comment explicitly avoided (installing tesseract-ocr via apt-get) — see
// that file's updated comment for the full tradeoff writeup. Accepted
// because correctness (a filing either fully validates or stays
// scanned_unparsed — see the all-or-nothing policy) matters more here than
// avoiding a Dockerfile edit, and this is now a proven, not theoretical,
// reliability gap.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { cpus } from 'os';
import { join } from 'path';
import { makeLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const log = makeLogger('ocr-tesseract-cli');

// Caps how many tesseract.exe processes run at once. Unbounded concurrency
// (dateOcr.ts/ownerOcr.ts's 5 reads x mccaulTemplate.ts's 3 cells per row can
// fan out to 15 simultaneous processes) was measured to spike the row
// failure rate from ~2/111 to 29/111 — process contention was starving
// individual tesseract runs badly enough that some either hit the 15s
// execFileAsync timeout or returned garbled/incomplete output that failed
// validation. Capping at the CPU count keeps every running process actually
// scheduled on a core instead of fighting for one, while still running
// well under a minute for the full filing (vs 70+ minutes fully sequential).
const MAX_CONCURRENT = Math.max(1, cpus().length);
let active = 0;
const queue: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  active++;
}

function releaseSlot(): void {
  active--;
  const next = queue.shift();
  if (next) next();
}

// Resolved once per process. On the Apify image (Debian, apt-get installed)
// this is just "tesseract" on PATH. Locally on Windows during development,
// the installer doesn't add it to PATH by default, so fall back to the
// UB-Mannheim installer's default location if the bare command isn't found
// — see the .catch() in resolveTesseractPath.
const WINDOWS_DEFAULT_PATH = 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe';

let resolvedPathPromise: Promise<string> | null = null;

async function resolveTesseractPath(): Promise<string> {
  if (!resolvedPathPromise) {
    resolvedPathPromise = (async () => {
      try {
        await execFileAsync('tesseract', ['--version']);
        return 'tesseract';
      } catch {
        // Not on PATH — try the Windows default install location before
        // giving up (production/Docker always has it on PATH; this
        // fallback only matters for local Windows development).
        try {
          await execFileAsync(WINDOWS_DEFAULT_PATH, ['--version']);
          return WINDOWS_DEFAULT_PATH;
        } catch {
          throw new Error(
            'tesseract CLI not found on PATH and not at the default Windows install location. ' +
            'Install it (Dockerfile: apt-get install -y tesseract-ocr; local dev: winget install UB-Mannheim.TesseractOCR).',
          );
        }
      }
    })();
  }
  return resolvedPathPromise;
}

export interface TesseractCliOptions {
  psm?: number;
  whitelist?: string;
}

// Runs one Tesseract CLI invocation against a PNG buffer: writes it to a
// temp file (the CLI needs a real file path, not stdin, for reliable
// behavior across platforms), invokes `tesseract <file> stdout <flags>`,
// captures stdout as the recognized text, and cleans up. One process per
// call — no persistent worker, no shared mutable state between calls, which
// is exactly the property that fixes the tesseract.js defect this module
// replaces.
export async function ocrImageBuffer(buffer: Buffer, options: TesseractCliOptions = {}): Promise<string> {
  await acquireSlot();
  try {
    const tesseractPath = await resolveTesseractPath();
    const dir = await mkdtemp(join(tmpdir(), 'house-ocr-'));
    const inputPath = join(dir, 'input.png');

    try {
      await writeFile(inputPath, buffer);

      const args = [inputPath, 'stdout'];
      if (options.psm !== undefined) args.push('--psm', String(options.psm));
      if (options.whitelist !== undefined) args.push('-c', `tessedit_char_whitelist=${options.whitelist}`);

      const { stdout } = await execFileAsync(tesseractPath, args, { timeout: 15_000 });
      return stdout.trim();
    } catch (err) {
      log.warn(`ocrImageBuffer: tesseract CLI invocation failed: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    releaseSlot();
  }
}

// Reads a version string once, for a startup sanity check / log line (not
// currently called anywhere but useful for diagnostics).
export async function tesseractCliVersion(): Promise<string> {
  const tesseractPath = await resolveTesseractPath();
  const { stderr, stdout } = await execFileAsync(tesseractPath, ['--version']).catch((err) => {
    throw new Error(`tesseract --version failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  // tesseract prints version info to stderr on some builds, stdout on others.
  return (stdout || stderr).split('\n')[0] ?? 'unknown';
}
