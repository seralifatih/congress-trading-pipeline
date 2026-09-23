import { isValid, parseISO } from 'date-fns';
import type { Transaction } from '../types/index.js';

const VALID_TYPES = new Set(['buy', 'sell', 'exchange']);
const VALID_OWNERS = new Set(['self', 'joint', 'spouse', 'child']);

export function validateTransaction(t: Transaction): string[] {
  const errors: string[] = [];

  // A 'scanned_unparsed' placeholder has every transaction-detail field
  // null by design (see normalize.ts) — none of the checks below apply.
  if (t.parse_status === 'scanned_unparsed') return errors;

  if (t.transaction_date === null || !isValid(parseISO(t.transaction_date))) {
    errors.push(`transaction_date "${t.transaction_date}" is not a valid date`);
  }

  if (!isValid(parseISO(t.filing_date))) {
    errors.push(`filing_date "${t.filing_date}" is not a valid date`);
  }

  if (t.amount_min !== null && t.amount_max !== null && t.amount_min > t.amount_max) {
    errors.push(`amount_min (${t.amount_min}) > amount_max (${t.amount_max})`);
  }

  if (t.type === null || !VALID_TYPES.has(t.type)) {
    errors.push(`type "${t.type}" must be "buy", "sell", or "exchange"`);
  }

  if (t.owner === null || !VALID_OWNERS.has(t.owner)) {
    errors.push(`owner "${t.owner}" must be one of: self, joint, spouse, child`);
  }

  return errors;
}
