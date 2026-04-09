import { Router } from 'express';
import { z } from 'zod';
import { requireMasterOrDeviceKey } from '../middlewares/auth.js';
import { validate } from '../middlewares/validator.js';
import { deviceManager } from '../services/DeviceManager.js';
import { enqueueMessage } from '../services/MessageQueue.js';

const router = Router();

// Allow either Master Key or Device-specific Key for sending messages
router.use(requireMasterOrDeviceKey);

// ─── Common fields ─────────────────────────────────────────────────────────────

const deviceAndTo = z.object({
  device_id: z.string().min(1),
  to:        z.string().regex(/^\d{7,15}$/, 'Phone number must be 7-15 digits, no + or spaces'),
});

// ─── Schemas ──────────────────────────────────────────────────────────────────

const textSchema = deviceAndTo.extend({
  message: z.string().min(1).max(4096),
  // Optional: reply to a specific message ID
  quoted_message_id: z.string().optional(),
});

const imageSchema = deviceAndTo.extend({
  url:     z.string().url(),
  caption: z.string().max(1024).optional(),
});

const videoSchema = deviceAndTo.extend({
  url:     z.string().url(),
  caption: z.string().max(1024).optional(),
});

const documentSchema = deviceAndTo.extend({
  url:      z.string().url(),
  filename: z.string().min(1).max(255).optional(),
  caption:  z.string().max(1024).optional(),
  mimetype: z.string().optional(),
});

const audioSchema = deviceAndTo.extend({
  url:      z.string().url(),
  // ptt = Push-to-talk (voice note) — plays in mono style
  ptt:      z.boolean().default(false),
  mimetype: z.string().default('audio/mpeg'),
});

const locationSchema = deviceAndTo.extend({
  latitude:  z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name:      z.string().max(255).optional(),
  address:   z.string().max(512).optional(),
});

const contactSchema = deviceAndTo.extend({
  contact_name:  z.string().min(1).max(100),
  contact_phone: z.string().regex(/^\d{7,15}$/),
});

const bulkSchema = z.object({
  device_id: z.string().min(1),
  numbers:   z.array(z.string().regex(/^\d{7,15}$/)).min(1).max(500),
  type:      z.enum(['text', 'image', 'video', 'document', 'audio']),
  // For text
  message: z.string().max(4096).optional(),
  // For media
  url:     z.string().url().optional(),
  caption: z.string().max(1024).optional(),
  // For document
  filename: z.string().max(255).optional(),
  mimetype: z.string().optional(),
}).refine(
  (d) => !(d.type === 'text' && !d.message),
  { message: '`message` is required when type is text', path: ['message'] }
).refine(
  (d) => !(d.type !== 'text' && !d.url),
  { message: '`url` is required for media types', path: ['url'] }
);

const personalizedSchema = z.object({
  device_id: z.string().min(1),
  messages: z.array(z.object({
    to:      z.string().regex(/^\d{7,15}$/, 'Phone number must be 7-15 digits'),
    message: z.string().min(1).max(4096),
  })).min(1).max(200),
});

// ─── Helper: guard device connected ───────────────────────────────────────────

function assertConnected(deviceId, res) {
  const client = deviceManager.get(deviceId);
  if (!client) {
    res.status(404).json({ success: false, message: `Device "${deviceId}" not found` });
    return null;
  }
  if (client.status !== 'connected') {
    res.status(409).json({
      success: false,
      message: `Device "${deviceId}" is not connected (status: ${client.status})`,
    });
    return null;
  }
  return client;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/send/text
 * Send a plain text message.
 */
router.post('/text', validate(textSchema), async (req, res) => {
  const { device_id, to, message } = req.body;
  if (!assertConnected(device_id, res)) return;

  try {
    const content = { text: message };
    const result  = await enqueueMessage(device_id, to, content, 'text');
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/send/image
 * Send an image from a public URL.
 */
router.post('/image', validate(imageSchema), async (req, res) => {
  const { device_id, to, url, caption } = req.body;
  if (!assertConnected(device_id, res)) return;

  try {
    const content = { image: { url }, caption: caption ?? '' };
    const result  = await enqueueMessage(device_id, to, content, 'image');
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/send/video
 * Send a video from a public URL.
 */
router.post('/video', validate(videoSchema), async (req, res) => {
  const { device_id, to, url, caption } = req.body;
  if (!assertConnected(device_id, res)) return;

  try {
    const content = { video: { url }, caption: caption ?? '' };
    const result  = await enqueueMessage(device_id, to, content, 'video');
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/send/document
 * Send a file/document from a public URL.
 */
router.post('/document', validate(documentSchema), async (req, res) => {
  const { device_id, to, url, filename, caption, mimetype } = req.body;
  if (!assertConnected(device_id, res)) return;

  try {
    const content = {
      document: { url },
      fileName: filename ?? 'file',
      caption:  caption ?? '',
      mimetype: mimetype ?? 'application/octet-stream',
    };
    const result = await enqueueMessage(device_id, to, content, 'document');
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/send/audio
 * Send audio. Set ptt=true to send as voice note.
 */
router.post('/audio', validate(audioSchema), async (req, res) => {
  const { device_id, to, url, ptt, mimetype } = req.body;
  if (!assertConnected(device_id, res)) return;

  try {
    const content = { audio: { url }, ptt, mimetype };
    const result  = await enqueueMessage(device_id, to, content, 'audio');
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/send/location
 * Send a GPS location pin.
 */
router.post('/location', validate(locationSchema), async (req, res) => {
  const { device_id, to, latitude, longitude, name, address } = req.body;
  if (!assertConnected(device_id, res)) return;

  try {
    const content = {
      location: {
        degreesLatitude:  latitude,
        degreesLongitude: longitude,
        name:    name ?? '',
        address: address ?? '',
      },
    };
    const result = await enqueueMessage(device_id, to, content, 'location');
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/send/contact
 * Send a contact card (vCard).
 */
router.post('/contact', validate(contactSchema), async (req, res) => {
  const { device_id, to, contact_name, contact_phone } = req.body;
  if (!assertConnected(device_id, res)) return;

  try {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact_name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact_phone}:+${contact_phone}`,
      'END:VCARD',
    ].join('\n');

    const content = {
      contacts: {
        displayName: contact_name,
        contacts: [{ vcard }],
      },
    };
    const result = await enqueueMessage(device_id, to, content, 'contact');
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/send/bulk
 * Queue a message to multiple recipients.
 * Each recipient becomes a separate queue job.
 */
router.post('/bulk', validate(bulkSchema), async (req, res) => {
  const { device_id, numbers, type, message, url, caption, filename, mimetype } = req.body;
  if (!assertConnected(device_id, res)) return;

  // Build content based on type
  let content;
  if (type === 'text') {
    content = { text: message };
  } else if (type === 'image') {
    content = { image: { url }, caption: caption ?? '' };
  } else if (type === 'video') {
    content = { video: { url }, caption: caption ?? '' };
  } else if (type === 'document') {
    content = {
      document: { url },
      fileName: filename ?? 'file',
      caption:  caption ?? '',
      mimetype: mimetype ?? 'application/octet-stream',
    };
  } else if (type === 'audio') {
    content = { audio: { url }, ptt: false, mimetype: mimetype ?? 'audio/mpeg' };
  }

  try {
    const results = await Promise.all(
      numbers.map((num) => enqueueMessage(device_id, num, content, type))
    );
    return res.json({
      success:  true,
      queued:   results.length,
      message:  `${results.length} messages queued`,
      jobs:     results,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/send/personalized
 * Queue different messages for different recipients in one request.
 */
router.post('/personalized', validate(personalizedSchema), async (req, res) => {
  const { device_id, messages } = req.body;
  if (!assertConnected(device_id, res)) return;

  try {
    const results = await Promise.all(
      messages.map((item) => 
        enqueueMessage(device_id, item.to, { text: item.message }, 'text')
      )
    );
    return res.json({
      success: true,
      queued:  results.length,
      message: `${results.length} personalized messages queued`,
      jobs:    results,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
