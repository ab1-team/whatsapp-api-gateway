import { Queue, Worker } from 'bullmq';
import { nanoid } from 'nanoid';
import { config } from '../config/index.js';
import { deviceManager } from './DeviceManager.js';
import { logger } from '../utils/logger.js';
import db from '../database/db.js';

// ─── Redis connection ──────────────────────────────────────────────────────────

const redisConnection = {
  host:               config.redis.host,
  port:               config.redis.port,
  password:           config.redis.password || undefined,
  db:                 config.redis.db,
  // Prevent Redis errors from crashing the process
  enableOfflineQueue: false,
  lazyConnect:        true,
  maxRetriesPerRequest: null, // Required by BullMQ
  retryStrategy: (times) => {
    // Reconnect with exponential backoff, max 30s
    const delay = Math.min(1000 * 2 ** Math.min(times, 5), 30_000);
    logger.warn({ attempt: times, delayMs: delay, context: 'redis' }, 'Redis reconnecting…');
    return delay;
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const stmts = {
  insertLog:   null,
  updateLog:   null,
  dailyCount:  null,
  upsertDaily: null,
};

function initStmts() {
  if (stmts.insertLog) return;
  stmts.insertLog = db.prepare(`
    INSERT INTO message_logs (id, device_id, recipient, type, status, queued_at)
    VALUES (?, ?, ?, ?, 'queued', datetime('now'))
  `);
  stmts.updateLog = db.prepare(`
    UPDATE message_logs
    SET status = ?, error_message = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `);
  stmts.dailyCount = db.prepare(
    'SELECT count FROM daily_stats WHERE device_id = ? AND date = ?'
  );
  stmts.upsertDaily = db.prepare(`
    INSERT INTO daily_stats (device_id, date, count) VALUES (?, ?, 1)
    ON CONFLICT (device_id, date) DO UPDATE SET count = count + 1
  `);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay() {
  const { minDelay, maxDelay } = config.rateLimit;
  return Math.floor(Math.random() * (maxDelay - minDelay) + minDelay);
}

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

// ─── Queue ────────────────────────────────────────────────────────────────────

/**
 * Global BullMQ queue.
 * Rate limiting is applied per-device using BullMQ's groupKey feature.
 */
export const messageQueue = new Queue('wa-messages', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:  5,
    backoff:   { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 500 },
  },
});

messageQueue.on('error', (err) => {
  logger.error({ err: err.message, context: 'queue' }, 'Queue connection error (Redis unavailable?)');
});

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker(
  'wa-messages',
  async (job) => {
    const { deviceId, to, content, type, logId } = job.data;
    initStmts();

    // 1. Daily limit check
    if (config.rateLimit.dailyLimit > 0) {
      const row = stmts.dailyCount.get(deviceId, todayDate());
      if (row && row.count >= config.rateLimit.dailyLimit) {
        throw new Error(
          `Daily limit of ${config.rateLimit.dailyLimit} messages reached for device ${deviceId}`
        );
      }
    }

    // 2. Anti-spam: random delay before sending
    const delay = randomDelay();
    logger.debug({ deviceId, to, type, delayMs: delay, context: 'queue' }, 'Sending after delay…');
    await sleep(delay);

    // 3. Get device client
    const client = deviceManager.get(deviceId);
    if (!client) throw new Error(`Device ${deviceId} not loaded`);
    if (client.status !== 'connected') throw new Error(`Device ${deviceId} not connected (status: ${client.status})`);

    // 4. Send message via Baileys
    try {
      await client.sendMessage(to, content);
    } catch (sendErr) {
      // If timed out or connection error, restart the device so the next retry is fresh
      if (
        sendErr.message?.includes('Timed Out') ||
        sendErr.message?.includes('timed out') ||
        sendErr.message?.includes('Connection Closed') ||
        sendErr.message?.includes('not connected')
      ) {
        logger.warn({ deviceId, err: sendErr.message, context: 'queue' }, 'Send failed — restarting device connection for retry');
        deviceManager.restart(deviceId).catch(() => {}); // restart async, don't block
      }
      throw sendErr; // Re-throw so BullMQ registers failure and retries
    }

    // 5. Update stats & log
    stmts.upsertDaily.run(deviceId, todayDate());
    stmts.updateLog.run('sent', null, 'sent', logId);

    logger.info({ deviceId, to, type, context: 'queue' }, 'Message sent ✓');
  },
  {
    connection:  redisConnection,
    concurrency: 5,
    limiter: {
      max:      config.rateLimit.messagesPerMinute,
      duration: 60_000,
      groupKey: 'deviceId', // Per-device rate limiting
    },
    autorun: false, // Don't start automatically — we control startup
  }
);

worker.on('completed', (job) => {
  logger.debug({ jobId: job.id, context: 'queue' }, 'Job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message, context: 'queue' }, 'Job failed');
  if (job?.data?.logId) {
    initStmts();
    stmts.updateLog.run('failed', err.message, 'failed', job.data.logId);
  }
});

worker.on('error', (err) => {
  // Log but don't crash — Redis might be temporarily unavailable
  logger.error({ err: err.message, context: 'queue' }, 'Worker error (Redis unavailable?)');
});

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises the queue worker. Call this after the HTTP server is listening.
 * Returns false if Redis is unavailable (non-fatal).
 */
export async function initQueue() {
  try {
    // Test Redis connection
    const client = await messageQueue.client;
    await client.ping();
    worker.run(); // Start processing
    logger.info({ context: 'queue' }, 'BullMQ queue & worker started');
    return true;
  } catch (err) {
    logger.warn(
      { err: err.message, context: 'queue' },
      '⚠️  Redis not available — message queue disabled. Messages will be sent directly (no anti-spam delay).'
    );
    return false;
  }
}

/**
 * Adds a message to the queue (or sends directly if Redis is down).
 */
export async function enqueueMessage(deviceId, to, content, type) {
  const logId = nanoid(16);
  initStmts();
  stmts.insertLog.run(logId, deviceId, to, type);

  try {
    const job = await messageQueue.add(
      `${type}:${deviceId}`,
      { deviceId, to, content, type, logId },
      { jobId: `${deviceId}:${Date.now()}:${Math.random().toString(36).slice(2)}` }
    );
    return { logId, jobId: job.id, queued: true };
  } catch (err) {
    // Redis unavailable fallback: send directly with minimal delay
    logger.warn({ deviceId, to, context: 'queue' }, 'Redis unavailable, sending directly');
    const client = deviceManager.get(deviceId);
    if (!client) throw new Error(`Device ${deviceId} not loaded`);
    await sleep(randomDelay());
    await client.sendMessage(to, content);
    stmts.updateLog.run('sent', null, 'sent', logId);
    return { logId, jobId: null, queued: false };
  }
}

/**
 * Gracefully shuts down the worker and queue.
 */
export async function shutdownQueue() {
  try {
    await worker.close();
    await messageQueue.close();
    logger.info({ context: 'queue' }, 'Queue shutdown complete');
  } catch { /* ignore */ }
}
