import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Auth
  masterKey: process.env.MASTER_API_KEY || 'ganti-dengan-key-rahasia',

  // Database
  dbPath: process.env.DB_PATH || './data/gateway.db',

  // Sessions (Baileys auth state stored as files)
  sessionsDir: process.env.SESSIONS_DIR || './sessions',

  // Redis
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0'),
  },

  // Anti-Spam / Rate Limiting
  rateLimit: {
    // Max messages per minute per device (processed by queue worker)
    messagesPerMinute: parseInt(process.env.RATE_LIMIT_MESSAGES || '20'),
    // Min random delay between messages (ms)
    minDelay: parseInt(process.env.MIN_DELAY_MS || '1000'),
    // Max random delay between messages (ms)
    maxDelay: parseInt(process.env.MAX_DELAY_MS || '3500'),
    // Max messages per day per device (0 = unlimited)
    dailyLimit: parseInt(process.env.DAILY_MESSAGE_LIMIT || '500'),
  },

  // Webhook
  webhookTimeout: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000'),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};
