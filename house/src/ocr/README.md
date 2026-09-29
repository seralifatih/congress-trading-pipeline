# OCR prototype — status: disabled

This module recovers transactions from House PTRs that have no PDF text
layer (scanned/paper filings). It is a working prototype for exactly one
filer template (McCaul) and is currently **disabled by default**
(`ENABLE_OCR=false` / actor input `enableOcr: false` — see
`src/utils/config.ts` and `src/fetcher/houseFetcher.ts`). With it off, a
scanned filing goes straight to the `scanned_unparsed` placeholder, byte-for-
byte the same behavior as before this module existed.

Read this before resuming the work.

## Why it's off

On the one real filing this has been measured against in full (McCaul,
DocID 9116211, 6 pages, 111 data rows), the pipeline:

- Spends ~90-100 seconds of OCR compute (rasterize 6 pages + run the native
  Tesseract CLI once per read, 5 reads per date/owner cell, ~230+ cells)
- Still rejects the filing every time, because of a residual defect (below)
  that the all-or-nothing validation policy correctly catches

So turning it on today means paying ~96s per scanned filing for zero
recovered rows on the one filing tested end to end. Not worth it until the
residual defect is closed or worked around.

## What works

- Page-layout template detection (`mccaulTemplate.ts`'s `matchesTemplate`) —
  reliable, cheap, no OCR involved
- Gridline-based column/row boundary detection (`imageGrid.ts`) — no
  hardcoded pixel offsets, adapts per page
- Checkbox/mark reading for type and amount columns (ink-density comparison,
  not OCR text reading) — reliable
- Asset-name OCR via tesseract.js (`textOcr.ts`) — no defect ever found here
- Date and owner-code OCR via the native Tesseract CLI, one process per
  read, 5-read true-majority vote with full calendar/owner-code validation
  (`dateOcr.ts`, `ownerOcr.ts`, `tesseractCli.ts`) — see below for the one
  thing that's still wrong with it
- On the single-page fixture (`tests/fixtures/9116211_page1.pdf`, 25 rows),
  this reads and validates cleanly and repeatably

## The residual defect: "2" read as "7"

Tesseract (confirmed on both tesseract.js and the native CLI — see
`tesseractCli.ts`'s header comment for the byte-for-byte diagnosis that
proved tesseract.js has its own, separate defect) has a real, non-random
misread of the printed digit "2" as "7" in certain date cells on this scan,
at a low but nonzero rate.

**History of the investigation** (each step measured on the full 111-row
McCaul filing, not just isolated cells):

1. Original nearest-neighbor upscale + hard threshold: ~18-22% misread rate
   at upscale=4, ~7.5% at upscale=6. Mixing both scales in the 5-read vote
   (3 configs at upscale=4, 2 at upscale=6) biased the majority vote toward
   the worse scale → 29/111 rows failed validation.
2. Root cause found: nearest-neighbor upscaling produces aliased,
   stair-stepped edges on this glyph that confuse Tesseract's classifier.
   Switching to canvas-native **bilinear** upscaling
   (`imageSmoothingEnabled`/`high`) and standardizing all 5 reads on
   upscale=6 dropped failures to **4/111**.
3. Further attempts, all tested directly against the 4 remaining failing
   cells, none of which closed the gap:
   - Fine and dense threshold sweeps (9 samples instead of 5) — helps one
     cell, not the others; the "correct" threshold band is narrow and
     cell-specific, not a fixed value
   - PSM 6/7/8/11/13 — no mode is reliably correct; PSM 8 fixes the year
     digit on one crop but breaks the month digit on the same crop
   - OEM 1 (LSTM, default) vs OEM 3 — identical results, no improvement
   - **OEM 0 (legacy) and OEM 2 (legacy+LSTM) are not usable at all** on
     this Tesseract install — it only ships `eng.traineddata` for the LSTM
     engine, no legacy model, so these modes error out immediately. This
     rules out "try the legacy engine" as an option without also bundling a
     legacy-capable trained data file.
   - The `digits` built-in config (`tessedit_char_whitelist 0123456789-.`)
     — drops the `/` separator entirely (not in its whitelist) and still
     shows the same "2"→"7" confusion
   - One of the 4 cells (`page6_row4`) is wrong at **every single tested
     threshold (9/9)** — a fully deterministic misread with zero
     exploitable variance. No amount of voting or threshold tuning recovers
     this specific crop.

**Conclusion**: this is a genuine ceiling of Tesseract's digit classifier on
this scan's printed "2" glyph, not a preprocessing bug. All four crops read
correctly to a human eye. Closing this gap would need either a different
OCR engine/model, or a domain-knowledge correction (e.g. "if a read's year
is invalid but swapping one 2↔7 digit lands it in range, and that's the
only valid candidate, use it") — the latter was explicitly ruled out during
this work as too close to "guessing," which the all-or-nothing validation
policy is designed to prevent. Revisit that tradeoff explicitly if you want
to pursue it; don't add it silently.

## Test coverage

- `tests/ocr.test.js` — unit tests (template matching, amount ranges) plus
  two fast-ish integration tests against `tests/fixtures/9116211_page1.pdf`
  (page 1 only, passes cleanly, ~20s each)
- A third integration test runs the **full 6-page** filing
  (`tests/fixtures/9116211_full.pdf`) and asserts the filing is currently
  **rejected** — this is intentional: it records real, current behavior
  (including the residual defect above) instead of hiding it behind a
  trimmed fixture. It's gated behind `RUN_SLOW_TESTS=1` (~95s on its own)
  since it would otherwise triple the normal suite's runtime. Run
  `RUN_SLOW_TESTS=1 npm test` after touching anything under `src/ocr/`.
  **If a future fix gets this filing passing, update that test's assertion
  to match — don't leave it pinned to "always rejects."**

## If you pick this back up

- Start from the 4-cell residual defect above, not from scratch — the
  preprocessing pipeline (rasterize → gridline detection → bilinear
  upscale+binarize → CLI OCR → majority vote → calendar/owner validation →
  all-or-nothing filing reject) is solid and shouldn't need rearchitecting.
- Re-run `RUN_SLOW_TESTS=1 npm test` first to confirm the current 4/111
  failure count hasn't drifted (Tesseract version, font rendering, etc.).
- Khanna (the next filer template in the original priority order) hasn't
  been started — this defect is McCaul-specific in its measured rate, but
  likely applies to any template using the native CLI date/owner path,
  since it's a Tesseract classifier issue, not a McCaul-template issue.
- Before re-enabling `ENABLE_OCR` by default, get this specific filing (or
  a representative sample of McCaul filings) passing validation, and
  re-measure the ~96s cost against how often scanned filings actually
  appear in the real feed — it may still not be worth it depending on
  volume.
