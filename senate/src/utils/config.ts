import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DB_PATH: z.string().default('./data/pipeline.db'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CRON_SCHEDULE: z.string().default('0 */6 * * *'),
  FETCH_DAYS_BACK: z.coerce.number().int().min(1).max(365).default(90),
  CRON_SECRET: z.string().default(''),
  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),
  LAST_RUN_PATH: z.string().default('./data/last_run.json'),
});

function load() {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    // Config errors are fatal — print before logger is ready
    console.error('[config] Invalid environment:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const config = load();
export type Config = typeof config;
