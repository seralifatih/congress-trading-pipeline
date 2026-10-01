// Actor input -> validated pipeline options. Pure (no Apify SDK) so it can be
// unit-tested. Every field is optional; an empty input is today's behavior.

export interface ActorInput {
  fetchDaysBack?: number;
  fromDate?: string;
  toDate?: string;
  debugPtrLimit?: number;
  members?: string[];
  tickers?: string[];
  transactionDateFrom?: string;
  transactionDateTo?: string;
  includeDuplicates?: boolean;
  debugPdfText?: boolean;
  enableOcr?: boolean;
}

export interface ParsedInput {
  fetchDaysBack?: number;
  fromDate?: string;
  toDate?: string;
  debugPtrLimit?: number;
  members: string[];
  tickers: string[];
  transactionDateFrom?: string;
  transactionDateTo?: string;
  includeDuplicates: boolean;
  debugPdfText: boolean;
  enableOcr: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new Error(`Input "${name}" must be a YYYY-MM-DD date (got ${JSON.stringify(value)})`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`Input "${name}" is not a real calendar date (got "${value}")`);
  }
  return value;
}

function checkStringList(name: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Input "${name}" must be an array of strings`);
  }
  return value.map((v: string) => v.trim()).filter((v) => v.length > 0);
}

/** "$aapl" -> "AAPL". Share-class separators are compared dot/dash-insensitively. */
export function normalizeTickerFilterValue(t: string): string {
  return t.trim().replace(/^\$/, '').toUpperCase().replace(/-/g, '.');
}

/** Actor input -> runPipeline options. Pure; apify.ts passes the result straight through. */
export function toPipelineOptions(input: ParsedInput) {
  return {
    fromDate: input.fromDate,
    toDate: input.toDate,
    fetchDaysBack: input.fetchDaysBack,
    debugPtrLimit: input.debugPtrLimit,
    enableOcr: input.enableOcr || undefined,
    members: input.members,
    tickers: input.tickers,
    transactionDateFrom: input.transactionDateFrom,
    transactionDateTo: input.transactionDateTo,
    includeDuplicates: input.includeDuplicates,
  };
}

export function parseInput(input: ActorInput | null | undefined): ParsedInput {
  const i = input ?? {};
  const fromDate = checkDate('fromDate', i.fromDate);
  const toDate = checkDate('toDate', i.toDate);
  const transactionDateFrom = checkDate('transactionDateFrom', i.transactionDateFrom);
  const transactionDateTo = checkDate('transactionDateTo', i.transactionDateTo);

  if (fromDate && toDate && fromDate > toDate) {
    throw new Error(`Input "fromDate" (${fromDate}) is after "toDate" (${toDate})`);
  }
  if (transactionDateFrom && transactionDateTo && transactionDateFrom > transactionDateTo) {
    throw new Error(
      `Input "transactionDateFrom" (${transactionDateFrom}) is after "transactionDateTo" (${transactionDateTo})`,
    );
  }

  return {
    fetchDaysBack: i.fetchDaysBack ? i.fetchDaysBack : undefined,
    fromDate,
    toDate,
    debugPtrLimit: i.debugPtrLimit ? i.debugPtrLimit : undefined,
    members: checkStringList('members', i.members),
    tickers: checkStringList('tickers', i.tickers).map(normalizeTickerFilterValue),
    transactionDateFrom,
    transactionDateTo,
    includeDuplicates: i.includeDuplicates === true,
    debugPdfText: i.debugPdfText === true,
    enableOcr: i.enableOcr === true,
  };
}
