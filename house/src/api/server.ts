import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { SqliteStore } from '../store/sqliteStore.js';
import { toErrorMessage } from '../utils/errors.js';
import { makeLogger } from '../utils/logger.js';
import { runPipeline } from '../scheduler/pipeline.js';
import type { PipelineSummary, Transaction } from '../types/index.js';

const log = makeLogger('server');

import { config } from '../utils/config.js';

// CONTRACT.md §1: frontend uses relative paths — same origin, no external CORS
// needed in production. FRONTEND_ORIGIN lets the server run standalone in dev.
const { PORT, CRON_SECRET, FRONTEND_ORIGIN } = config;

// ─── Serializer ───────────────────────────────────────────────────────────────
// CONTRACT.md §3: Transaction fields map 1-to-1 to frontend Signal fields
// with these renames:
//   Transaction.politician   → Signal.filer_name
//   Transaction.type         → Signal.trade_type  ('buy'→'purchase', 'sell'→'sale')
//   Transaction.amount_min   → Signal.amount_low
//   Transaction.amount_max   → Signal.amount_high
//   Transaction.transaction_date → Signal.trade_date

function serialize(t: Transaction): Record<string, unknown> {
  return {
    id: t.id ?? null,
    filer_name: t.politician,
    filer_type: 'congress' as const,
    party: null,                        // TODO (open question 5b): populate from DB once party column added
    trade_type: t.type === 'buy' ? 'purchase' : 'sale',
    ticker: t.ticker,
    company_name: null,                 // Phase 2: ticker→company enrichment
    asset_name: t.asset_name,
    asset_type: t.asset_type,
    amount_low: t.amount_min,
    amount_high: t.amount_max,
    // TODO (open question 5a): amount_midpoint not in Transaction schema yet;
    // compute here once amount_max is always present, or handle null case.
    amount_midpoint: t.amount_max !== null
      ? Math.round((t.amount_min + t.amount_max) / 2)
      : null,
    trade_date: t.transaction_date,
    filing_date: t.filing_date,
    // TODO (open question 5c): filing_delay_days not computed yet;
    // will be derived from trade_date + filing_date once pipeline stores it.
    filing_delay_days: null,
    owner: t.owner,
    score: null,                        // Phase 2: scoring engine
    score_breakdown: null,              // Phase 2: scoring engine
    filters_passed: [],
    cluster_id: null,
    committees: null,                   // TODO (open question 5b): add committees column
    is_active: true,
    created_at: t.created_at ?? null,
  };
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireCronSecret(req: Request, res: Response, next: NextFunction): void {
  const secret =
    (req.headers['x-cron-secret'] as string | undefined) ??
    (req.query['secret'] as string | undefined);

  if (!CRON_SECRET || secret !== CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ─── Pipeline adapter ─────────────────────────────────────────────────────────
// Maps PipelineStats → PipelineSummary shape CONTRACT.md §2 expects.

async function runPipelineForRoute(): Promise<PipelineSummary> {
  const stats = await runPipeline();
  return {
    ingested: stats.inserted + stats.skipped,
    newTrades: stats.inserted,
    signalsGenerated: stats.inserted,
    topScore: null,
    topScoreTicker: null,
    runAt: new Date().toISOString(),
  };
}

// ─── Request logger ───────────────────────────────────────────────────────────

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    log.info(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
}

// ─── Zod schemas for query param validation ───────────────────────────────────

const QuerySchema = z.object({
  politician: z.string().optional(),
  ticker: z.string().optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
  type: z.enum(['buy', 'sell']).optional(),
  owner: z.enum(['self', 'joint', 'spouse', 'child']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ─── App factory ─────────────────────────────────────────────────────────────

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(requestLogger);

  // CORS — same-origin in production; allow FRONTEND_ORIGIN in standalone dev
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers['origin'];
    if (origin === FRONTEND_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── GET /api/refresh ────────────────────────────────────────────────────────
  // CONTRACT.md §2: returns { lastUpdated: string | null }
  app.get('/api/refresh', async (_req: Request, res: Response) => {
    try {
      const store = SqliteStore.getInstance();
      const rows = await store.query({ limit: 1 });
      const lastUpdated = rows[0]?.created_at ?? null;
      res.json({ lastUpdated });
    } catch (err) {
      // GET /api/refresh errors are silently swallowed by the frontend (.catch(()=>{}))
      // so any shape is fine here — but keep the field name correct.
      res.status(500).json({ lastUpdated: null });
    }
  });

  // ── POST /api/refresh ───────────────────────────────────────────────────────
  // CONTRACT.md §2: triggers pipeline, returns { ok, signals, lastUpdated }
  // Error shape must be { ok: false, error: string } — frontend reads json.error
  app.post('/api/refresh', async (_req: Request, res: Response) => {
    try {
      const summary = await runPipelineForRoute();
      const store = SqliteStore.getInstance();
      const rows = await store.query({ limit: 1 });
      const lastUpdated = rows[0]?.created_at ?? new Date().toISOString();
      res.json({
        ok: true,
        signals: summary.signalsGenerated,
        lastUpdated,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }
  });

  // ── GET /api/cron ───────────────────────────────────────────────────────────
  // CONTRACT.md §2: protected by CRON_SECRET; returns { ok, summary }
  app.get('/api/cron', requireCronSecret, async (_req: Request, res: Response) => {
    try {
      const summary = await runPipelineForRoute();
      res.json({ ok: true, summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }
  });

  // ── GET /api/sync-committees ────────────────────────────────────────────────
  // CONTRACT.md §2: protected by CRON_SECRET; returns { ok, synced }
  // TODO: wire to real committee sync once congress.ts client is built.
  app.get('/api/sync-committees', requireCronSecret, async (_req: Request, res: Response) => {
    try {
      // TODO: call fetchCommitteeMembership() + upsertCommitteeMembers() here
      res.json({ ok: true, synced: 0 });
    } catch (err) {
      res.status(500).json({ ok: false, error: toErrorMessage(err) });
    }
  });

  // ── GET /api/debug ──────────────────────────────────────────────────────────
  // CONTRACT.md §2: dev diagnostics, no auth
  app.get('/api/debug', async (_req: Request, res: Response) => {
    try {
      const store = SqliteStore.getInstance();
      const count = store.count();
      const sample = await store.query({ limit: 2 });
      res.json({
        quiverKeySet: !!process.env['QUIVER_API_KEY'],
        rawCount: count,
        sourceCounts: { congress: count, insiders: 0 },
        fetchErrors: {},
        filterResult: null,
        sampleTrades: {
          congress: sample.map(serialize),
          insiders: [],
        },
      });
    } catch (err) {
      res.status(500).json({ error: toErrorMessage(err) });
    }
  });

  // ── GET /api/transactions ───────────────────────────────────────────────────
  // Pipeline-specific read endpoint — not in CONTRACT.md (frontend doesn't call it)
  // but needed to verify stored data and for future integrations.
  app.get('/api/transactions', async (req: Request, res: Response) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const store = SqliteStore.getInstance();
      const rows = await store.query(parsed.data);
      res.json({ data: rows.map(serialize), count: rows.length });
    } catch (err) {
      res.status(500).json({ error: toErrorMessage(err) });
    }
  });

  // ── GET /health ─────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    try {
      const store = SqliteStore.getInstance();
      const db_count = store.count();
      // last_run: most recently inserted record
      store.query({ limit: 1 }).then((rows) => {
        res.json({
          status: 'ok',
          db_count,
          last_run: rows[0]?.created_at ?? null,
        });
      }).catch(() => {
        res.json({ status: 'ok', db_count, last_run: null });
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: toErrorMessage(err) });
    }
  });

  return app;
}

// ─── Start ────────────────────────────────────────────────────────────────────

export function startServer(): void {
  const app = createApp();
  app.listen(PORT, () => {
    log.info(`Listening on port ${PORT}`);
  });
}
