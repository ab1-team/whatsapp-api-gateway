import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  isJidGroup,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { mkdirSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import qrcode from 'qrcode';
import axios from 'axios';
import { config } from '../config/index.js';
import { logger, getBaileysLogger } from '../utils/logger.js';
import db from '../database/db.js';

export class WhatsAppClient {
  static #stmtUpdateDevice;
  static #stmtGetWebhook;

  static #initStmts() {
    if (this.#stmtUpdateDevice) return;
    this.#stmtUpdateDevice = db.prepare(`
      UPDATE devices SET
        status       = ?,
        phone_number = COALESCE(?, phone_number),
        last_seen_at = CASE WHEN ? = 'connected' THEN datetime('now') ELSE last_seen_at END,
        updated_at   = datetime('now')
      WHERE id = ?
    `);
    this.#stmtGetWebhook = db.prepare(
      'SELECT webhook_url, webhook_events FROM devices WHERE id = ?'
    );
  }

  /**
   * @param {string} deviceId
   * @param {string} deviceName
   * @param {import('socket.io').Server} io
   */
  constructor(deviceId, deviceName, io) {
    WhatsAppClient.#initStmts();
    this.deviceId   = deviceId;
    this.deviceName = deviceName;
    this.io         = io;

    this.sock              = null;
    this.status            = 'disconnected';
    this.phoneNumber       = null;
    this.qrString          = null;
    this.reconnectAttempts = 0;
    this.destroyed         = false; // flag to stop reconnect loop

    this.sessionPath = resolve(join(config.sessionsDir, deviceId));
    this._log = logger.child({ context: 'wa-client', deviceId });
  }

  // ─── Connection ──────────────────────────────────────────────────────────────

  async connect() {
    if (this.destroyed) return;

    try {
      // Lazy-create directory only when needed
      mkdirSync(this.sessionPath, { recursive: true });

      const { version } = await fetchLatestBaileysVersion();
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

      this.sock = makeWASocket({
        version,
        logger: getBaileysLogger(),
        browser: Browsers.macOS('Desktop'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, getBaileysLogger()),
        },
        printQRInTerminal:              false,
        generateHighQualityLinkPreview: false,
        syncFullHistory:                false,
        shouldSyncHistoryMessage:       () => false, // No history sync
        getMessage:                     async () => undefined, // Don't store messages
        cachedGroupMetadata:            async () => undefined, // Ignore groups
        shouldIgnoreJid: (jid) => isJidGroup(jid) || isJidBroadcast(jid), // Ignore group/broadcast activity
        markOnlineOnConnect:            false,
        connectTimeoutMs:               60_000,
        keepAliveIntervalMs:            25_000,
        defaultQueryTimeoutMs:          60_000,
        emitOwnEvents:                  false,
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', (u) => this._onConnectionUpdate(u));
      this.sock.ev.on('messages.upsert', ({ messages }) => this._onMessages(messages));

      this._log.info('Connecting…');
    } catch (err) {
      this._log.error({ err: err.message }, 'connect() failed');
      this._setStatus('error');
      this._scheduleReconnect();
    }
  }

  // ─── Event handlers ──────────────────────────────────────────────────────────

  async _onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    // New QR code available
    if (qr) {
      this.qrString = qr;
      this._setStatus('waiting_qr');

      try {
        const qrImage = await qrcode.toDataURL(qr, { margin: 2 });
        this.io.to(`device:${this.deviceId}`).emit('qr', {
          device_id: this.deviceId,
          qr_string: qr,
          qr_image:  qrImage,
        });
        this._log.info('QR emitted');
      } catch (err) {
        this._log.error({ err: err.message }, 'QR generation failed');
      }
    }

    // Connection closed unexpectedly or by user
    if (connection === 'close') {
      const errCode  = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : 0;

      const loggedOut = errCode === DisconnectReason.loggedOut;

      this._log.info({ errCode, loggedOut }, 'Connection closed');

      this.sock = null;
      this._setStatus('disconnected');

      if (this.destroyed) return;

      if (loggedOut) {
        this._log.warn('Device logged out — clearing session');
        await this._clearSession();
      } else {
        this._scheduleReconnect();
      }
    }

    // Successfully authenticated and connected
    if (connection === 'open') {
      this.reconnectAttempts = 0;
      this.qrString          = null;
      this.phoneNumber       = this.sock?.user?.id?.split(':')[0] ?? null;

      this._setStatus('connected');

      this.io
        .to(`device:${this.deviceId}`)
        .to('global:logs')
        .emit('ready', {
          device_id:    this.deviceId,
          phone_number: this.phoneNumber,
          name:         this.deviceName,
        });

      this._log.info({ phone: this.phoneNumber }, 'Device ready ✓');
    }
  }

  async _onMessages(messages) {
    // RAM Optimization: Only process messages if a webhook is enabled and we care about them.
    // Since you requested "Minimalist Mode", we skip processing entirely to save CPU/RAM.
    this._log.debug({ count: messages.length }, 'Messages received (skipped processing)');
  }

  // ─── Sending ─────────────────────────────────────────────────────────────────

  /**
   * Sends a WhatsApp message.
   * @param {string} to  - Phone number (international format, digits only)
   * @param {object} content - Baileys message content object
   */
  async sendMessage(to, content) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error(`Device "${this.deviceId}" is not connected (status: ${this.status})`);
    }
    const jid = this._toJid(to);
    await this.sock.sendMessage(jid, content);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  async logout() {
    this.destroyed = true;
    try {
      if (this.sock) {
        await this.sock.logout();
        this.sock.end();
        this.sock = null;
      }
    } catch { /* ignore */ }
    await this._clearSession();
  }

  async disconnect() {
    this.destroyed = true;
    try {
      this.sock?.end();
      this.sock = null;
    } catch { /* ignore */ }
    this._setStatus('disconnected');
  }

  async restart() {
    this.destroyed = false;
    this.reconnectAttempts = 0;
    try {
      this.sock?.end();
      this.sock = null;
    } catch { /* ignore */ }
    await this.connect();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _setStatus(status) {
    this.status = status;
    WhatsAppClient.#stmtUpdateDevice.run(status, this.phoneNumber, status, this.deviceId);
    this.io
      .to(`device:${this.deviceId}`)
      .to('global:logs')
      .emit('status', {
        device_id: this.deviceId,
        status,
      });
  }

  _scheduleReconnect() {
    if (this.destroyed || this.reconnectAttempts >= 10) {
      this._log.warn('Max reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    // Exponential back-off: 2s, 4s, 8s … capped at 60s
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 60_000);
    this._log.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Scheduling reconnect');
    setTimeout(() => this.connect(), delay);
  }

  async _clearSession() {
    try {
      await rm(this.sessionPath, { recursive: true, force: true });
      this._log.info('Session cleared');
    } catch (err) {
      this._log.error({ err: err.message }, 'Failed to clear session');
    }
    this.phoneNumber = null;
    this._setStatus('disconnected');
  }

  _toJid(phone) {
    let digits = String(phone).replace(/\D/g, '');
    // Auto-convert Indonesian local format (08...) to international format (628...)
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    return `${digits}@s.whatsapp.net`;
  }

  _formatIncoming(msg) {
    const typeKey = Object.keys(msg.message || {})[0];
    const m = msg.message?.[typeKey] ?? {};

    return {
      event:      'message',
      device_id:  this.deviceId,
      message_id: msg.key.id,
      timestamp:  new Date((msg.messageTimestamp ?? 0) * 1000).toISOString(),
      from:       msg.key.remoteJid?.split('@')[0],
      is_group:   isJidGroup(msg.key.remoteJid ?? ''),
      type:       typeKey,
      text:       m.text ?? m.caption ?? m.conversation ?? null,
    };
  }

  // ─── Info ─────────────────────────────────────────────────────────────────────

  getInfo() {
    return {
      id:           this.deviceId,
      name:         this.deviceName,
      status:       this.status,
      phone_number: this.phoneNumber,
      has_qr:       !!this.qrString,
    };
  }
}
