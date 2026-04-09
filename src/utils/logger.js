import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino(
  {
    level: config.logLevel,
    // Suppress noisy Baileys internal logs in production
    ...(config.nodeEnv !== 'production' && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: '[{context}] {msg}',
        },
      },
    }),
  }
);

/**
 * Returns a child logger with suppressed level for Baileys internal logs.
 * Hides the very verbose Baileys debug/trace messages.
 */
export function getBaileysLogger() {
  return logger.child({ context: 'baileys', level: 'error' });
}
