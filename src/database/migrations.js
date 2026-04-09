import db from './db.js';
import { logger } from '../utils/logger.js';

export function runMigrations() {
  db.exec(`
    -- ------------------------------------------------
    -- Devices: metadata for each registered WA number
    -- ------------------------------------------------
    CREATE TABLE IF NOT EXISTS devices (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      api_key         TEXT UNIQUE NOT NULL,
      phone_number    TEXT,
      status          TEXT NOT NULL DEFAULT 'disconnected',
      webhook_url     TEXT,
      webhook_events  TEXT NOT NULL DEFAULT '["message"]',
      is_active       INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at    TEXT
    );

    -- ------------------------------------------------
    -- Message logs: audit trail for sent messages
    -- ------------------------------------------------
    CREATE TABLE IF NOT EXISTS message_logs (
      id            TEXT PRIMARY KEY,
      device_id     TEXT NOT NULL,
      recipient     TEXT NOT NULL,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'queued',
      error_message TEXT,
      queued_at     TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at       TEXT,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    -- ------------------------------------------------
    -- Daily stats: per-device message count per day
    -- ------------------------------------------------
    CREATE TABLE IF NOT EXISTS daily_stats (
      device_id  TEXT NOT NULL,
      date       TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device_id, date),
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_message_logs_device_id ON message_logs(device_id);
    CREATE INDEX IF NOT EXISTS idx_message_logs_status    ON message_logs(status);
    CREATE INDEX IF NOT EXISTS idx_devices_api_key        ON devices(api_key);
  `);

  logger.info({ context: 'db' }, 'Migrations completed');
}
