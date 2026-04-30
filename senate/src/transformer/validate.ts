import { isValid, parseISO } from 'date-fns';
import type { Transaction } from '../types/index.js';

const VALID_TYPES = new Set(['buy', 'sell']);
const VALID_OWNERS = new Set(['self', 'joint', 'spouse', 'child']);

export function validateTransaction(t: Transaction): string[] {
  const errors: string[] = [];

  if (!isValid(parseISO(t.transaction_date))) {
    errors.push(`transaction_date "${t.transaction_date}" is not a valid date`);
  }

  if (!isValid(parseISO(t.filing_date))) {
    errors.push(`filing_date "${t.filing_date}" is not a valid date`);
  }

  if (t.amount_max !== null && t.amount_min > t.amount_max) {
    errors.push(`amount_min (${t.amount_min}) > amount_max (${t.amount_max})`);
  }

  if (!VALID_TYPES.has(t.type)) {
    errors.push(`type "${t.type}" must be "buy" or "sell"`);
  }

  if (!VALID_OWNERS.has(t.owner)) {
    errors.push(`owner "${t.owner}" must be one of: self, joint, spouse, child`);
  }

  return errors;
}
