/**
 * Configuration module
 * Loads environment variables and provides defaults
 */

require('dotenv').config();

module.exports = {
  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/deepclaw_analytics'
  },
  
  // Server
  server: {
    port: parseInt(process.env.PORT) || 3000,
    env: process.env.NODE_ENV || 'development'
  },
  
  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: '30d'
  },
  
  // Nostr
  nostr: {
    relays: (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band,wss://nostr.wine').split(',')
  },
  
  // Webhooks
  webhooks: {
    timeout: parseInt(process.env.DEFAULT_WEBHOOK_TIMEOUT_MS) || 5000,
    retryCount: parseInt(process.env.WEBHOOK_RETRY_COUNT) || 3
  },
  
  // Rate Limiting
  rateLimits: {
    free: parseInt(process.env.FREE_TIER_RATE_LIMIT) || 100,
    premium: parseInt(process.env.PREMIUM_TIER_RATE_LIMIT) || 1000
  },
  
  // Lightning
  lightning: {
    enabled: process.env.LIGHTNING_ENABLED === 'true'
  }
};
