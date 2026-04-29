import { makeLogger } from './utils/logger.js';
import { startServer } from './api/index.js';
import { startScheduler } from './scheduler/index.js';

const log = makeLogger('process');

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason) });
  process.exit(1);
});

startServer();
startScheduler();
