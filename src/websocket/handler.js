import db from '../database/db.js';
import { deviceManager } from '../services/DeviceManager.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import qrcode from 'qrcode';

/**
 * Sets up Socket.io authentication and event handling.
 * @param {import('socket.io').Server} io
 */
export function setupWebSocket(io) {
  const stmtDevice = db.prepare(
    'SELECT id, name, api_key FROM devices WHERE id = ? AND api_key = ? AND is_active = 1'
  );

  // ─── Authentication middleware ──────────────────────────────────────────────
  io.use((socket, next) => {
    const { device_id, api_key } = socket.handshake.query;
    const key = (api_key || '').toString().trim();
    const masterKey = (config.masterKey || '').toString().trim();

    if (!device_id || !key) {
      return next(new Error('Missing device_id or api_key query params'));
    }

    // Allow master key to connect to any device room
    if (key === masterKey) {
      socket.deviceId   = device_id || 'all'; // Default to 'all' if not provided
      socket.isMasterKey = true;
      return next();
    }

    // Validate device-specific API key
    const device = stmtDevice.get(device_id, key);
    if (!device) {
      console.warn(`[WS_AUTH] Unauthorized connection attempt. Device: ${device_id}, Key: ${key.substring(0, 5)}...`);
      return next(new Error('Unauthorized: invalid device_id or api_key'));
    }

    socket.deviceId = device.id;
    return next();
  });

  // ─── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const { deviceId } = socket;
    logger.info({ deviceId, socketId: socket.id, context: 'ws' }, 'Client connected');

    // Join device-specific room so events are delivered to the right clients
    socket.join(`device:${deviceId}`);

    // If master key, also join global room to receive logs for ALL devices
    if (socket.isMasterKey) {
      socket.join('global:logs');
    }

    // Immediately send current state to the newly connected client
    const client = deviceManager.get(deviceId);
    if (client) {
      // Send current status
      socket.emit('status', { device_id: deviceId, status: client.status });

      // If QR is pending, re-emit it
      if (client.status === 'waiting_qr' && client.qrString) {
        try {
          const qrImage = await qrcode.toDataURL(client.qrString, { margin: 2 });
          socket.emit('qr', {
            device_id: deviceId,
            qr_string: client.qrString,
            qr_image:  qrImage,
          });
        } catch { /* ignore */ }
      }

      // If already connected, send ready event with phone number
      if (client.status === 'connected') {
        socket.emit('ready', {
          device_id:    deviceId,
          phone_number: client.phoneNumber,
          name:         client.deviceName,
        });
      }
    } else if (deviceId !== 'all') {
      socket.emit('status', { device_id: deviceId, status: 'not_loaded' });
    }

    socket.on('disconnect', (reason) => {
      logger.info({ deviceId, reason, context: 'ws' }, 'Client disconnected');
    });

    // Client can request a QR refresh
    socket.on('request_qr', async () => {
      const c = deviceManager.get(deviceId);
      if (!c) return socket.emit('error', { message: 'Device not found' });

      if (c.status === 'waiting_qr' && c.qrString) {
        try {
          const img = await qrcode.toDataURL(c.qrString, { margin: 2 });
          socket.emit('qr', { device_id: deviceId, qr_string: c.qrString, qr_image: img });
        } catch { /* ignore */ }
      } else {
        socket.emit('status', { device_id: deviceId, status: c.status });
      }
    });
  });

  logger.info({ context: 'ws' }, 'WebSocket handler ready');
}
