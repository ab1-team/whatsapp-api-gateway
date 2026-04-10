import { WhatsAppClient } from './WhatsAppClient.js';
import { readdirSync, existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import { config } from '../config/index.js';
import db from '../database/db.js';
import { logger } from '../utils/logger.js';

class DeviceManager {
  #stmtAllActive;
  #stmtAllIds;
  #stmtFindByName;

  constructor() {
    /** @type {Map<string, WhatsAppClient>} */
    this.clients = new Map();
    /** @type {import('socket.io').Server|null} */
    this.io = null;
    this._log = logger.child({ context: 'device-manager' });
  }

  #initStmts() {
    if (this.#stmtAllActive) return;
    this.#stmtAllActive = db.prepare('SELECT id, name FROM devices WHERE is_active = 1');
    this.#stmtAllIds    = db.prepare('SELECT id FROM devices');
    this.#stmtFindByName = db.prepare('SELECT * FROM devices WHERE name = ? AND is_active = 1 LIMIT 1');
  }

  // Called once when the server starts
  setSocketIO(io) {
    this.io = io;
  }

  /**
   * Loads all active devices from DB and initiates their connections.
   * Called at server startup.
   */
  async loadAll() {
    // 1. Clean up unused session folders first
    await this._cleanupSessions();

    // 2. Cleanup abandoned devices in DB (more than 60 minutes)
    await this.cleanupAbandonedDevices(60);

    // 3. Setup periodic cleanup every hour
    setInterval(() => {
      this.cleanupAbandonedDevices(60);
    }, 60 * 60 * 1000);

    this.#initStmts();
    const devices = this.#stmtAllActive.all();
    this._log.info({ count: devices.length }, 'Loading registered devices…');

    // Connect all in parallel (non-blocking)
    await Promise.allSettled(
      devices.map((d) => this._createAndConnect(d.id, d.name))
    );
  }

  /**
   * Registers a new device in DB and starts its WA client.
   */
  async registerDevice(id, name) {
    if (this.clients.has(id)) {
      return this.clients.get(id);
    }
    return this._createAndConnect(id, name);
  }

  /**
   * Returns the WhatsApp client instance for a device.
   * @param {string} deviceId
   * @returns {WhatsAppClient|undefined}
   */
  get(deviceId) {
    return this.clients.get(deviceId);
  }

  /**
   * Removes a device: logs out, clears session, removes from map.
   */
  async remove(deviceId) {
    const client = this.clients.get(deviceId);
    if (client) {
      // Use disconnect instead of logout to avoid Baileys trying to talk to WA server
      await client.disconnect();
      this.clients.delete(deviceId);
    }
  }

  /**
   * Stops a device, CLEARS its session folder, and starts a fresh connection.
   * This ensures "Scan = Folder Kosong".
   */
  async resetAndConnect(id, name) {
    // 1. Remove from runtime
    await this.remove(id);

    // 2. Force delete session folder
    const sessionPath = resolve(join(config.sessionsDir, id));
    try {
      if (existsSync(sessionPath)) {
        await rm(sessionPath, { recursive: true, force: true });
        this._log.info({ id }, 'Session folder cleared for fresh scan');
      }
    } catch (err) {
      this._log.error({ id, err: err.message }, 'Failed to clear session folder');
    }

    // 3. Start fresh
    return this._createAndConnect(id, name);
  }

  /**
   * Restarts a device connection.
   */
  async restart(deviceId) {
    const client = this.clients.get(deviceId);
    if (!client) throw new Error(`Device ${deviceId} not found`);
    await client.restart();
  }

  /**
   * Returns snapshot info for all loaded devices.
   */
  getAllInfo() {
    return Array.from(this.clients.values()).map((c) => c.getInfo());
  }

  /**
   * Finds an existing device by name.
   */
  getDeviceByName(name) {
    this.#initStmts();
    return this.#stmtFindByName.get(name);
  }

  /**
   * Deletes records and folders for devices that stayed disconnected/waiting_qr for too long.
   */
  async cleanupAbandonedDevices(maxAgeMinutes = 60) {
    try {
      const dbPath = resolve(config.sessionsDir);
      
      // Get IDs of abandoned devices BEFORE deleting them from DB
      const abandoned = db.prepare(`
        SELECT id FROM devices 
        WHERE status IN ('disconnected', 'waiting_qr') 
          AND updated_at < datetime('now', '-' || ? || ' minutes')
          AND is_active = 1
      `).all(maxAgeMinutes);

      if (abandoned.length === 0) return;

      this._log.info({ count: abandoned.length, threshold: `${maxAgeMinutes}m` }, 'Cleaning up abandoned devices…');

      for (const { id } of abandoned) {
        // Stop runtime client if exists
        await this.remove(id);
        
        // Final DB deletion ( migrations have ON DELETE CASCADE for logs/stats )
        db.prepare('DELETE FROM devices WHERE id = ?').run(id);
        
        // Double check session folder removal
        const sessionPath = resolve(join(config.sessionsDir, id));
        if (existsSync(sessionPath)) {
          await rm(sessionPath, { recursive: true, force: true });
        }
      }
      
      this._log.info('Cleanup completed');
    } catch (err) {
      this._log.error({ err: err.message }, 'Abandoned cleanup failed');
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────────

  async _createAndConnect(id, name) {
    const client = new WhatsAppClient(id, name, this.io);
    this.clients.set(id, client);
    // Fire and forget — connection is async
    client.connect().catch((err) => {
      this._log.error({ deviceId: id, err: err.message }, 'Initial connection error');
    });
    return client;
  }

  /**
   * Deletes session directories that are NOT found in the database.
   * Keeps the 'garbage' out of the session folder.
   */
  async _cleanupSessions() {
    try {
      const sessionsDir = resolve(config.sessionsDir);
      if (!existsSync(sessionsDir)) return;

      const folders     = readdirSync(sessionsDir);
      this.#initStmts();
      const dbDeviceIds = new Set(this.#stmtAllIds.all().map(d => d.id));

      for (const folder of folders) {
        if (!dbDeviceIds.has(folder)) {
          this._log.warn({ folder, context: 'cleanup' }, 'Removing orphaned session folder');
          await rm(join(sessionsDir, folder), { recursive: true, force: true });
        }
      }
    } catch (err) {
      this._log.error({ err: err.message }, 'Cleanup sessions failed');
    }
  }
}

// Singleton
export const deviceManager = new DeviceManager();
