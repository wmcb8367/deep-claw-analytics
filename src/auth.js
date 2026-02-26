/**
 * Authentication middleware and utilities
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

/**
 * Generate API token
 */
function generateApiToken() {
  return 'dc_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Generate webhook secret
 */
function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Verify HMAC signature
 */
function verifySignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(JSON.stringify(payload)).digest('hex');
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(digest)
    );
  } catch {
    return false;
  }
}

/**
 * Middleware: Authenticate API requests via Bearer token
 * Supports both user registration tokens and long-lived API tokens
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header'
      });
    }
    
    const token = authHeader.substring(7);
    
    // First, try to find a long-lived API token (from api_tokens table)
    const apiTokenResult = await db.query(
      `SELECT t.*, u.* 
       FROM api_tokens t
       JOIN users u ON t.user_id = u.id
       WHERE t.token = $1 
         AND t.revoked = FALSE
         AND (t.expires_at IS NULL OR t.expires_at > NOW())`,
      [token]
    );
    
    if (apiTokenResult.rows.length > 0) {
      const tokenData = apiTokenResult.rows[0];
      
      // Update last_used for the token
      await db.query(
        'UPDATE api_tokens SET last_used = NOW() WHERE token = $1',
        [token]
      );
      
      // Update user last_active
      await db.query(
        'UPDATE users SET last_active = NOW() WHERE id = $1',
        [tokenData.user_id]
      );
      
      // Attach user and token info to request
      req.user = {
        id: tokenData.user_id,
        npub: tokenData.npub,
        email: tokenData.email,
        tier: tokenData.tier,
        webhook_url: tokenData.webhook_url,
        created_at: tokenData.created_at,
        last_active: tokenData.last_active
      };
      req.tokenScopes = tokenData.scopes || [];
      
      return next();
    }
    
    // Fall back to user registration token (from users table)
    const userResult = await db.query(
      'SELECT * FROM users WHERE api_token = $1',
      [token]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid API token'
      });
    }
    
    // Update last_active
    await db.query(
      'UPDATE users SET last_active = NOW() WHERE id = $1',
      [userResult.rows[0].id]
    );
    
    // Attach user to request (all scopes for user tokens)
    req.user = userResult.rows[0];
    req.tokenScopes = ['*']; // Full access with user token
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Middleware: Rate limiting based on tier
 */
async function rateLimit(req, res, next) {
  try {
    const user = req.user;
    const endpoint = req.path;
    const windowStart = new Date();
    windowStart.setHours(windowStart.getHours(), 0, 0, 0);
    
    // Check current usage
    const result = await db.query(
      `SELECT COALESCE(SUM(request_count), 0) as total
       FROM api_usage
       WHERE user_id = $1 AND window_start = $2`,
      [user.id, windowStart]
    );
    
    const currentUsage = parseInt(result.rows[0].total);
    const limit = user.tier === 'premium' 
      ? config.rateLimits.premium 
      : config.rateLimits.free;
    
    if (currentUsage >= limit) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: `You have exceeded the ${user.tier} tier limit of ${limit} requests per hour`,
        limit,
        remaining: 0,
        resetAt: new Date(windowStart.getTime() + 3600000).toISOString()
      });
    }
    
    // Increment usage
    await db.query(
      `INSERT INTO api_usage (user_id, endpoint, request_count, window_start)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, endpoint, window_start)
       DO UPDATE SET request_count = api_usage.request_count + 1`,
      [user.id, endpoint, windowStart]
    );
    
    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', limit - currentUsage - 1);
    res.setHeader('X-RateLimit-Reset', Math.floor(windowStart.getTime() / 1000) + 3600);
    
    next();
  } catch (error) {
    console.error('Rate limiting error:', error);
    // Don't block request on rate limit errors
    next();
  }
}

module.exports = {
  generateApiToken,
  generateWebhookSecret,
  verifySignature,
  authenticate,
  rateLimit
};
