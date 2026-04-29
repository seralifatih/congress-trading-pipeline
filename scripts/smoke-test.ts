import http from 'http';

const BASE = `http://localhost:${process.env['PORT'] ?? 3001}`;

interface CheckResult {
  name: string;
  passed: boolean;
  reason?: string;
}

const results: CheckResult[] = [];

function pass(name: string) {
  results.push({ name, passed: true });
  console.log(`  ✓ ${name}`);
}

function fail(name: string, reason: string) {
  results.push({ name, passed: false, reason });
  console.log(`  ✗ ${name}: ${reason}`);
}

function get(path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    }).on('error', reject);
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

// ─── Checks ───────────────────────────────────────────────────────────────────

async function checkHealth() {
  console.log('\nGET /health');
  const { status, body } = await get('/health');

  if (status !== 200) { fail('status 200', `got ${status}`); return; }
  pass('status 200');

  if (!isObject(body)) { fail('body is object', 'not an object'); return; }
  pass('body is object');

  if (body['status'] === 'ok') pass('status = "ok"');
  else fail('status = "ok"', `got "${body['status']}"`);

  if (typeof body['db_count'] === 'number') pass('db_count is number');
  else fail('db_count is number', `got ${JSON.stringify(body['db_count'])}`);

  if ('last_run' in body) pass('last_run field present');
  else fail('last_run field present', 'missing');
}

async function checkTransactions() {
  console.log('\nGET /api/transactions');
  const { status, body } = await get('/api/transactions');

  if (status !== 200) { fail('status 200', `got ${status}`); return; }
  pass('status 200');

  if (!isObject(body)) { fail('body is object', 'not an object'); return; }
  pass('body is object');

  if (isArray(body['data'])) pass('data is array');
  else { fail('data is array', `got ${typeof body['data']}`); return; }

  if (typeof body['count'] === 'number') pass('count is number');
  else fail('count is number', `got ${JSON.stringify(body['count'])}`);

  if ((body['data'] as unknown[]).length > 0) pass('data non-empty');
  else fail('data non-empty', 'no rows returned (did you run seed first?)');

  const first = (body['data'] as unknown[])[0];
  if (!isObject(first)) { fail('first row is object', 'not an object'); return; }

  for (const field of ['filer_name', 'trade_type', 'trade_date', 'filing_date', 'amount_low']) {
    if (field in first) pass(`first row has "${field}"`);
    else fail(`first row has "${field}"`, 'field missing');
  }
}

async function checkTransactionsTicker() {
  console.log('\nGET /api/transactions?ticker=AAPL');
  const { status, body } = await get('/api/transactions?ticker=AAPL');

  if (status !== 200) { fail('status 200', `got ${status}`); return; }
  pass('status 200');

  if (!isObject(body)) { fail('body is object', 'not an object'); return; }
  if (!isArray(body['data'])) { fail('data is array', `got ${typeof body['data']}`); return; }

  const rows = body['data'] as unknown[];
  pass('data is array');

  if (rows.length > 0) pass('AAPL rows found');
  else fail('AAPL rows found', 'no results — did you run seed first?');

  const allAapl = rows.every((r) => isObject(r) && r['ticker'] === 'AAPL');
  if (allAapl) pass('all rows have ticker = "AAPL"');
  else fail('all rows have ticker = "AAPL"', 'ticker filter not applied correctly');
}

async function checkBadParam() {
  console.log('\nGET /api/transactions?date_from=not-a-date (expect 400)');
  const { status, body } = await get('/api/transactions?date_from=not-a-date');

  if (status === 400) pass('status 400 on invalid param');
  else fail('status 400 on invalid param', `got ${status}`);

  if (isObject(body) && 'error' in body) pass('error field present in 400 response');
  else fail('error field present in 400 response', JSON.stringify(body));
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke test against ${BASE}`);

  try {
    await checkHealth();
    await checkTransactions();
    await checkTransactionsTicker();
    await checkBadParam();
  } catch (err) {
    console.error('\nUnexpected error:', err);
    process.exit(1);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailed checks:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  ✗ ${r.name}: ${r.reason}`));
    process.exit(1);
  }

  process.exit(0);
}

main();
