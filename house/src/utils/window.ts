import { format, subDays } from 'date-fns';

// The run window is a FILING-date window: the House Clerk's index is
// filtered on each filing's FilingDate (see fetcher/houseFetcher.ts
// parseIndex), i.e. the date the PTR was filed — not the date of the trades
// inside it. A filing made today can report a trade from months ago and is
// returned by a 1-day window; transaction dates in a run's output therefore
// routinely reach back well before the window start.

export interface WindowInput {
  fromDate?: string;
  toDate?: string;
  fetchDaysBack?: number;
}

export function resolveWindow(
  input: WindowInput,
  defaultDaysBack: number,
  today: Date = new Date(),
): { fromDate: string; toDate: string } {
  const daysBack = input.fetchDaysBack ?? defaultDaysBack;
  return {
    fromDate: input.fromDate ?? format(subDays(today, daysBack), 'yyyy-MM-dd'),
    toDate: input.toDate ?? format(today, 'yyyy-MM-dd'),
  };
}
