import cron from 'node-cron';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { runPipeline } from './pipeline.js';
import { makeLogger } from '../utils/logger.js';
import { toErrorMessage } from '../utils/errors.js';
import { config } from '../utils/config.js';

const log = makeLogger('cron');

const LAST_RUN_PATH = config.LAST_RUN_PATH;
const SCHEDULE = config.CRON_SCHEDULE;

// ─── last_run persistence ─────────────────────────────────────────────────────

interface LastRun {
  timestamp: string;
  inserted: number;
  skipped: number;
  errors: number;
}

function readLastRun(): LastRun | null {
  try {
    const raw = readFileSync(LAST_RUN_PATH, 'utf-8');
    return JSON.parse(raw) as LastRun;
  } catch {
    return null;
  }
}

function writeLastRun(data: LastRun): void {
  try {
    mkdirSync(dirname(LAST_RUN_PATH), { recursive: true });
    writeFileSync(LAST_RUN_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    log.warn(`Could not write last_run.json: ${toErrorMessage(err)}`);
  }
}

// ─── Single run ───────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const started = new Date().toISOString();
  log.info(`Run started at ${started}`);

  try {
    const stats = await runPipeline();
    const record: LastRun = { timestamp: started, ...stats };
    writeLastRun(record);
    log.info(
      `Run complete — inserted=${stats.inserted} skipped=${stats.skipped} errors=${stats.errors}`,
    );
  } catch (err) {
    log.error(`Unhandled pipeline error: ${toErrorMessage(err)}`);
    writeLastRun({ timestamp: started, inserted: 0, skipped: 0, errors: 1 });
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function startScheduler(): void {
  const prev = readLastRun();
  if (prev) {
    log.info(`Last run: ${prev.timestamp} (inserted=${prev.inserted})`);
  }

  // Run immediately on startup — do not wait for first cron tick
  tick().catch((err) => log.error(`Startup run failed: ${toErrorMessage(err)}`));

  cron.schedule(SCHEDULE, () => {
    tick().catch((err) => log.error(`Scheduled run failed: ${toErrorMessage(err)}`));
  });

  log.info(`Scheduler registered (${SCHEDULE})`);
}
