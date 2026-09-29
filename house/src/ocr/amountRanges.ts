// Fixed House PTR disclosure brackets for the lettered amount-grid columns
// (A-K) used by every scanned checkbox/mark-grid template surveyed so far —
// read directly off the form's own column headers (see
// mccaulTemplate.ts). Column K is a boolean flag ("Transaction in a Spouse
// or Dependent Child Asset over $1,000,000"), not an amount bracket, so it's
// excluded here; a filing with a K mark has no dollar amount for that row on
// this form and is treated as amount_min/amount_max = null (see ocr/index.ts).
export const AMOUNT_COLUMN_RANGES: Record<string, { min: number; max: number | null }> = {
  A: { min: 1_000, max: 15_000 },
  B: { min: 15_001, max: 50_000 },
  C: { min: 50_001, max: 100_000 },
  D: { min: 100_001, max: 250_000 },
  E: { min: 250_001, max: 500_000 },
  F: { min: 500_001, max: 1_000_000 },
  G: { min: 1_000_001, max: 5_000_000 },
  H: { min: 5_000_001, max: 25_000_000 },
  I: { min: 25_000_001, max: 50_000_000 },
  J: { min: 50_000_001, max: null }, // "Over $50,000,000"
};
