import db from '../database/db.js';
import { config } from '../config/index.js';

let stmts = null;
function getStmts() {
  if (stmts) return stmts;
  stmts = {
    device: db.prepare(
      'SELECT id, name, api_key, is_active FROM devices WHERE id = ? AND api_key = ? AND is_active = 1'
    ),
    deviceByKey: db.prepare(
      'SELECT id, name, api_key, is_active FROM devices WHERE api_key = ? AND is_active = 1'
    ),
  };
  return stmts;
}

/**
 * Middleware: requires the master API key.
 * Used for admin operations (create device, list all devices).
 */
export function requireMasterKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== config.masterKey) {
    return res.status(401).json({ success: false, message: 'Invalid or missing master API key' });
  }
  next();
}

/**
 * Middleware: requires a valid device API key.
 * Resolves the device and attaches it to req.device.
 *
 * Expects `device_id` in req.body OR req.params,
 * and `X-API-Key` header with the device's API key.
 */
export function requireDeviceKey(req, res, next) {
  const apiKey   = req.headers['x-api-key'] || req.query.api_key;
  const deviceId = req.body?.device_id || req.params?.id;

  if (!apiKey) {
    return res.status(401).json({ success: false, message: 'Missing X-API-Key header' });
  }

  let device;
  if (deviceId) {
    device = getStmts().device.get(deviceId, apiKey);
  } else {
    // Allow lookup by key alone (API key is globally unique per device)
    device = getStmts().deviceByKey.get(apiKey);
  }

  if (!device) {
    return res.status(401).json({ success: false, message: 'Invalid API key or device not found' });
  }

  req.device = device;
  next();
}

/**
 * Middleware: allows master key OR a valid device key.
 * Used for per-device info endpoints accessible by both admin and device owner.
 */
export function requireMasterOrDeviceKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  const masterKey = config.masterKey;

  // Debugging (akan muncul di docker logs)
  if (key && key === masterKey) {
    return next();
  }

  // Jika gagal, log perbandingannya untuk investigasi
  if (key) {
    console.log(`[AUTH_DEBUG] Key mismatch! Header: "${key}" (${key.length}), Config: "${masterKey}" (${masterKey ? masterKey.length : 0})`);
  }

  return requireDeviceKey(req, res, next);
}
