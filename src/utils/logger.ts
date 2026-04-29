const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const ENV_LEVEL = (process.env['LOG_LEVEL'] ?? 'info') as Level;
const IS_PROD = process.env['NODE_ENV'] === 'production';

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= (LEVELS[ENV_LEVEL] ?? LEVELS.info);
}

function emit(level: Level, module: string, msg: string, ctx?: unknown): void {
  if (!shouldLog(level)) return;

  if (IS_PROD) {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      module,
      msg,
    };
    if (ctx !== undefined) line['ctx'] = ctx;
    process.stdout.write(JSON.stringify(line) + '\n');
  } else {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const prefix = `${ts} ${level.toUpperCase().padEnd(5)} [${module}]`;
    const ctxStr = ctx !== undefined ? ' ' + JSON.stringify(ctx) : '';
    const out = `${prefix} ${msg}${ctxStr}`;
    if (level === 'error' || level === 'warn') {
      process.stderr.write(out + '\n');
    } else {
      process.stdout.write(out + '\n');
    }
  }
}

export function makeLogger(module: string) {
  return {
    debug: (msg: string, ctx?: unknown) => emit('debug', module, msg, ctx),
    info:  (msg: string, ctx?: unknown) => emit('info',  module, msg, ctx),
    warn:  (msg: string, ctx?: unknown) => emit('warn',  module, msg, ctx),
    error: (msg: string, ctx?: unknown) => emit('error', module, msg, ctx),
  };
}
