/**
 * SQLite Database — menggunakan node:sqlite built-in Node.js 22.12+
 * Tidak membutuhkan package eksternal atau native compilation.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const dbPath = resolve(config.dbPath);

// Pastikan direktori ada
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

// Performance & reliability settings
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous  = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA cache_size   = -4000;
  PRAGMA temp_store   = MEMORY;
`);

logger.info({ path: dbPath, context: 'db' }, 'SQLite (node:sqlite) connected');

export default db;
