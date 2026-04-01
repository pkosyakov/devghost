/**
 * Centralized logger — pino with console + file output and daily rotation.
 *
 * Logs go to:
 *   - Console: pretty-printed in dev, JSON in production
 *   - File: .logs/server-YYYY-MM-DD.log (rotated daily, 14 days retention)
 *     — disabled on Vercel (VERCEL env set, ephemeral FS)
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info({ orderId }, 'Analysis started');
 *   logger.error({ err }, 'Pipeline failed');
 *
 *   // Child logger with persistent context:
 *   const log = logger.child({ jobId, orderId });
 *   log.info('Cloning repo...');
 */
import pino from 'pino';
import type { TransportTargetOptions } from 'pino';
import path from 'path';
import fs from 'fs';

const isDev = process.env.NODE_ENV !== 'production';
const isVercel = !!process.env.VERCEL;
const enableFileTransport = !isVercel;

const LOG_DIR = path.resolve(process.cwd(), '.logs');

// Ensure log directory exists (sync — runs once at startup)
if (enableFileTransport) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // If we can't create dir, file logging will be disabled
  }
}

// Build transport targets — only for local dev (worker threads crash on Vercel)
const targets: TransportTargetOptions[] = [];

if (!isVercel) {
  // Console transport
  targets.push({
    target: isDev ? 'pino-pretty' : 'pino/file',
    level: isDev ? 'debug' : 'info',
    options: isDev
      ? {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          singleLine: false,
        }
      : { destination: 1 }, // stdout
  });
}

// File transport with daily rotation — only when not on Vercel (ephemeral FS)
const logDirExists = enableFileTransport && fs.existsSync(LOG_DIR);
if (logDirExists) {
  targets.push({
    target: 'pino-roll',
    level: 'debug', // capture everything to file
    options: {
      file: path.join(LOG_DIR, 'server'),
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      limit: { count: 14 }, // keep 14 rotated files
      mkdir: true,
    },
  });
}

const pinoOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'devghost' },
  redact: {
    paths: [
      'githubAccessToken',
      'token',
      'password',
      'secret',
      '*.githubAccessToken',
      '*.token',
      '*.password',
    ],
    censor: '[REDACTED]',
  },
};

// On Vercel: write JSON to stdout directly (no worker thread / transport).
// Locally: use transport targets for pretty-printing and file rotation.
export const logger = targets.length > 0
  ? pino(pinoOptions, pino.transport({ targets }))
  : pino(pinoOptions);

// Convenience: tagged child loggers for subsystems
export const analysisLogger = logger.child({ module: 'analysis' });
export const pipelineLogger = logger.child({ module: 'pipeline' });
export const gitLogger = logger.child({ module: 'git' });
export const billingLogger = logger.child({ module: 'billing' });

export default logger;
