import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import db from '../database/db.js';
import { deviceManager } from '../services/DeviceManager.js';
import { requireMasterKey, requireMasterOrDeviceKey } from '../middlewares/auth.js';
import { validate } from '../middlewares/validator.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createDeviceSchema = z.object({
  name: z.string().min(1).max(100),
  webhook_url: z.string().url().optional(),
  webhook_events: z
    .array(z.enum(['message', 'status']))
    .default(['message']),
});

const updateWebhookSchema = z.object({
  webhook_url: z.string().url().nullable().optional(),
  webhook_events: z
    .array(z.enum(['message', 'status']))
    .optional(),
});

// ─── Prepared statements ──────────────────────────────────────────────────────

let stmts = null;
function getStmts() {
  if (stmts) return stmts;
  stmts = {
    insertDevice: db.prepare(`
      INSERT INTO devices (id, name, api_key, webhook_url, webhook_events)
      VALUES (?, ?, ?, ?, ?)
    `),
    allDevices:   db.prepare('SELECT * FROM devices ORDER BY created_at DESC'),
    oneDevice:    db.prepare('SELECT * FROM devices WHERE id = ?'),
    deleteDevice: db.prepare('UPDATE devices SET is_active = 0 WHERE id = ?'),
    updateWebhook: db.prepare(`
      UPDATE devices
      SET webhook_url = COALESCE(?, webhook_url),
          webhook_events = COALESCE(?, webhook_events),
          updated_at = datetime('now')
      WHERE id = ?
    `),
    messageLogs: db.prepare(`
      SELECT * FROM message_logs
      WHERE device_id = ?
      ORDER BY queued_at DESC
      LIMIT 50
    `),
  };
  return stmts;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/devices
 * Register a new device. Returns device_id and api_key.
 * Requires master API key.
 */
router.post('/', requireMasterKey, validate(createDeviceSchema), async (req, res) => {
  try {
    const { name, webhook_url, webhook_events } = req.body;

    // 1. Check if device with same name already exists
    const existing = deviceManager.getDeviceByName(name);
    
    if (existing) {
      const runtime = deviceManager.get(existing.id);
      
      // If already connected, don't allow duplicate registration
      if (runtime?.status === 'connected' || existing.status === 'connected') {
        return res.status(409).json({
          success: false,
          message: `Device with name "${name}" is already connected.`,
        });
      }

      // If disconnected/waiting_qr, REUSE it to prevent "nyampah"
      logger.info({ deviceId: existing.id, name, context: 'devices' }, 'Reusing existing device record');
      
      // Force reset and clear session for a fresh scan
      await deviceManager.resetAndConnect(existing.id, name);

      return res.json({
        success: true,
        message: 'Reusing existing device session. Connect via WebSocket to get QR.',
        device: {
          id:      existing.id,
          name:    existing.name,
          api_key: existing.api_key,
          status:  runtime?.status || existing.status,
          webhook_url:    existing.webhook_url,
          webhook_events: JSON.parse(existing.webhook_events),
        },
      });
    }

    // 2. If no existing device, create new
    const id      = nanoid(12);
    const apiKey  = `wag_${nanoid(32)}`;

    getStmts().insertDevice.run(id, name, apiKey, webhook_url ?? null, JSON.stringify(webhook_events));

    // Start the WhatsApp client in background
    await deviceManager.registerDevice(id, name);

    logger.info({ deviceId: id, name, context: 'devices' }, 'Device registered');

    return res.status(201).json({
      success:  true,
      message:  'Device registered. Connect via WebSocket to get QR code.',
      device: {
        id,
        name,
        api_key: apiKey,
        status:  'connecting',
        webhook_url:    webhook_url ?? null,
        webhook_events: webhook_events,
      },
    });
  } catch (err) {
    logger.error({ err: err.message, context: 'devices' }, 'Failed to create device');
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/devices
 * List all devices with their runtime status.
 * Requires master API key.
 */
router.get('/', requireMasterKey, (_req, res) => {
  try {
    const dbDevices   = getStmts().allDevices.all();
    const runtimeInfo = Object.fromEntries(
      deviceManager.getAllInfo().map((d) => [d.id, d])
    );

    const devices = dbDevices.map((d) => ({
      ...d,
      webhook_events: JSON.parse(d.webhook_events ?? '[]'),
      ...(runtimeInfo[d.id] ?? {}),
    }));

    return res.json({ success: true, count: devices.length, devices });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/devices/:id
 * Get a single device's info. Accessible with master key or device's own key.
 */
router.get('/:id', requireMasterOrDeviceKey, (req, res) => {
  const { id } = req.params;
  const device = getStmts().oneDevice.get(id);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

  const runtimeClient = deviceManager.get(id);
  return res.json({
    success: true,
    device: {
      ...device,
      webhook_events: JSON.parse(device.webhook_events ?? '[]'),
      ...(runtimeClient?.getInfo() ?? {}),
    },
  });
});

/**
 * DELETE /api/devices/:id
 * Soft-delete device, logout from WhatsApp, clear session.
 * Requires master API key.
 */
router.delete('/:id', requireMasterKey, async (req, res) => {
  const { id } = req.params;
  const device = getStmts().oneDevice.get(id);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

  try {
    getStmts().deleteDevice.run(id);
    await deviceManager.remove(id);
    logger.info({ deviceId: id, context: 'devices' }, 'Device deleted');
    return res.json({ success: true, message: 'Device deleted and session cleared' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/devices/:id/restart
 * Restart device connection. Useful after disconnection issues.
 * Requires master key or device key.
 */
router.post('/:id/restart', requireMasterOrDeviceKey, async (req, res) => {
  const { id } = req.params;
  try {
    await deviceManager.restart(id);
    return res.json({ success: true, message: 'Device restarting…' });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/devices/:id/logout
 * Log out the device without deleting it from DB.
 * Requires master key or device key.
 */
router.post('/:id/logout', requireMasterOrDeviceKey, async (req, res) => {
  const { id } = req.params;
  try {
    const client = deviceManager.get(id);
    if (!client) return res.status(404).json({ success: false, message: 'Device not found in runtime' });
    await client.logout();
    // Re-initialise so user can scan QR again
    await deviceManager.registerDevice(id, client.deviceName);
    return res.json({ success: true, message: 'Device logged out. Scan QR to reconnect.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/devices/:id/webhook
 * Update webhook URL and events.
 * Requires master key or device key.
 */
router.patch('/:id/webhook', requireMasterOrDeviceKey, validate(updateWebhookSchema), (req, res) => {
  const { id } = req.params;
  const { webhook_url, webhook_events } = req.body;
  try {
    getStmts().updateWebhook.run(
      webhook_url ?? null,
      webhook_events ? JSON.stringify(webhook_events) : null,
      id
    );
    return res.json({ success: true, message: 'Webhook updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/devices/cleanup/abandoned
 * Manually trigger cleanup of devices that haven't connected for more than 60 minutes.
 * Requires master API key.
 */
router.delete('/cleanup/abandoned', requireMasterKey, async (req, res) => {
  try {
    const minutes = parseInt(req.query.minutes || '60');
    await deviceManager.cleanupAbandonedDevices(minutes);
    return res.json({ success: true, message: `Cleanup completed for devices older than ${minutes} minutes.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/devices/:id/logs
 * Get last 50 message logs for a device.
 * Requires master key or device key.
 */
router.get('/:id/logs', requireMasterOrDeviceKey, (req, res) => {
  const { id } = req.params;
  const logs = getStmts().messageLogs.all(id);
  return res.json({ success: true, count: logs.length, logs });
});

export default router;
