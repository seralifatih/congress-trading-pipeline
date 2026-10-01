import { format, subDays } from 'date-fns';

// The run window is a FILING-date window: the Senate EFD search endpoint is
// queried with submitted_start_date / submitted_end_date (see
// fetcher/senateFetcher.ts fetchDataPage), i.e. the date the PTR was filed —
// not the date of the trades inside it. A filing made today can report a
// trade from two years ago and is returned by a 1-day window; a trade made
// yesterday in a filing not yet submitted is not returned by any window.

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
