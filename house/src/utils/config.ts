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
  // OCR prototype for scanned House PTRs (McCaul template only) — see
  // src/ocr/README.md. Defaults OFF: on the one real filing it's been
  // measured against, it burns ~96s of CLI OCR compute and still rejects
  // the filing every time (a residual Tesseract glyph defect — see the
  // README), so leaving it on by default would just be paying that cost
  // for no recovered rows. With it off, a scanned filing goes straight to
  // the scanned_unparsed placeholder exactly as before this prototype
  // existed — no behavior change for existing users.
  ENABLE_OCR: z.coerce.boolean().default(false),
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
