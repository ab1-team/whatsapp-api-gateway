import { Router } from 'express';
import devicesRouter  from './devices.js';
import messagesRouter from './messages.js';

const router = Router();

// Health check — no auth required
router.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
});

router.use('/devices', devicesRouter);
router.use('/send',    messagesRouter);

export default router;
