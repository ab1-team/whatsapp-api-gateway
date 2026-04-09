import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import rateLimit from 'express-rate-limit';
import cors from 'cors';

import { config }           from './config/index.js';
import { logger }           from './utils/logger.js';
import { runMigrations }    from './database/migrations.js';
import { deviceManager }    from './services/DeviceManager.js';
import { initQueue, shutdownQueue } from './services/MessageQueue.js';
import { setupWebSocket }   from './websocket/handler.js';
import apiRouter            from './routes/index.js';

// ─── Express app ──────────────────────────────────────────────────────────────

const app    = express();
const server = createServer(app);
const io     = new SocketIO(server, {
  cors: { origin: '*' },
  pingInterval: 25_000,
  pingTimeout:  60_000,
});

// ─── Middleware ───────────────────────────────────────────────────────────────

// Enable CORS for all origins and allow x-api-key header
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-Requested-With'],
  credentials: true
}));

// Basic security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Powered-By', 'WhatsApp Gateway');
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));

// Global HTTP rate limiter (anti-DDoS)
app.use(
  rateLimit({
    windowMs:         60_000, // 1 minute
    max:              300,    // max 300 requests per IP per minute
    standardHeaders:  true,
    legacyHeaders:    false,
    message: { success: false, message: 'Too many requests, please slow down.' },
  })
);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/api', apiRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack, context: 'app' }, 'Unhandled error');
  res.status(500).json({ success: false, message: err.message || 'Internal server error' });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function start() {
  try {
    // 1. Run database migrations
    runMigrations();

    // 2. Wire Socket.io to Device Manager
    deviceManager.setSocketIO(io);

    // 3. Setup WebSocket authentication + events
    setupWebSocket(io);

    // 4. Load and connect all registered devices
    await deviceManager.loadAll();

    // 5. Start HTTP server
    server.listen(config.port, config.host, async () => {
      logger.info(
        { host: config.host, port: config.port, env: config.nodeEnv, context: 'app' },
        `🚀 WhatsApp Gateway running on http://${config.host}:${config.port}`
      );
      // 6. Init BullMQ queue (non-fatal if Redis unavailable)
      await initQueue();
    });
  } catch (err) {
    logger.fatal({ err: err.message, context: 'app' }, 'Failed to start server');
    process.exit(1);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info({ signal, context: 'app' }, 'Shutting down gracefully…');

  server.close(async () => {
    try {
      await shutdownQueue();
      logger.info({ context: 'app' }, 'Queue closed');
    } catch { /* ignore */ }
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Log unhandled rejections instead of crashing
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason), context: 'app' }, 'Unhandled rejection');
});

start();
