#!/usr/bin/env node

/**
 * Deep Claw Analytics API Server
 * Multi-user Nostr analytics platform
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const timingAnalytics = require('./timing-analytics');
const networkScanner = require('./network-scanner');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========================================
// PUBLIC ENDPOINTS (No auth required)
// ========================================

/**
 * Register new user
 * POST /auth/register
 */
app.post('/auth/register', async (req, res) => {
  try {
    const { npub, email, webhook_url, webhook_secret } = req.body;
    
    // Validate required fields
    if (!npub || !webhook_url) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'npub and webhook_url are required'
      });
    }
    
    // Generate credentials
    const apiToken = auth.generateApiToken();
    const generatedSecret = webhook_secret || auth.generateWebhookSecret();
    
    // Insert user
    const result = await db.query(
      `INSERT INTO users (npub, email, webhook_url, webhook_secret, api_token)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, npub, email, webhook_url, api_token, tier, created_at`,
      [npub, email || null, webhook_url, generatedSecret, apiToken]
    );
    
    const user = result.rows[0];
    
    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        npub: user.npub,
        email: user.email,
        webhook_url: user.webhook_url,
        tier: user.tier,
        created_at: user.created_at
      },
      credentials: {
        api_token: user.api_token,
        webhook_secret: generatedSecret
      },
      message: 'User registered successfully. Save your API token and webhook secret securely!'
    });
    
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      return res.status(409).json({
        error: 'User already exists',
        message: 'This npub or email is already registered'
      });
    }
    
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to register user'
    });
  }
});

// ========================================
// AUTHENTICATED ENDPOINTS
// ========================================

/**
 * Get current user info
 * GET /auth/me
 */
app.get('/auth/me', auth.authenticate, (req, res) => {
  const { id, npub, email, webhook_url, tier, created_at, last_active } = req.user;
  
  res.json({
    id,
    npub,
    email,
    webhook_url,
    tier,
    created_at,
    last_active
  });
});

/**
 * Update webhook configuration
 * PUT /auth/webhook
 */
app.put('/auth/webhook', auth.authenticate, async (req, res) => {
  try {
    const { webhook_url, webhook_secret } = req.body;
    const userId = req.user.id;
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (webhook_url) {
      updates.push(`webhook_url = $${paramCount++}`);
      values.push(webhook_url);
    }
    
    if (webhook_secret) {
      updates.push(`webhook_secret = $${paramCount++}`);
      values.push(webhook_secret);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No updates provided',
        message: 'Provide webhook_url and/or webhook_secret'
      });
    }
    
    values.push(userId);
    
    await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount}`,
      values
    );
    
    res.json({
      success: true,
      message: 'Webhook configuration updated'
    });
    
  } catch (error) {
    console.error('Webhook update error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update webhook'
    });
  }
});

/**
 * Get metrics summary
 * GET /metrics/summary
 */
app.get('/metrics/summary', auth.authenticate, auth.rateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get follower count
    const followersResult = await db.query(
      'SELECT COUNT(*) as count FROM followers WHERE user_id = $1',
      [userId]
    );
    
    // Get post count and total engagement
    const postsResult = await db.query(
      `SELECT 
         COUNT(*) as post_count,
         COALESCE(SUM(likes), 0) as total_likes,
         COALESCE(SUM(reposts), 0) as total_reposts,
         COALESCE(SUM(replies), 0) as total_replies,
         COALESCE(SUM(zaps_count), 0) as total_zaps,
         COALESCE(SUM(zaps_sats), 0) as total_sats
       FROM posts WHERE user_id = $1`,
      [userId]
    );
    
    // Get recent engagement rate (last 7 days)
    const engagementResult = await db.query(
      `SELECT 
         COUNT(*) as recent_posts,
         COALESCE(AVG(likes + reposts + replies), 0) as avg_engagement
       FROM posts 
       WHERE user_id = $1 AND posted_at > NOW() - INTERVAL '7 days'`,
      [userId]
    );
    
    const followers = parseInt(followersResult.rows[0].count);
    const posts = postsResult.rows[0];
    const engagement = engagementResult.rows[0];
    
    res.json({
      followers,
      posts: parseInt(posts.post_count),
      engagement: {
        total_likes: parseInt(posts.total_likes),
        total_reposts: parseInt(posts.total_reposts),
        total_replies: parseInt(posts.total_replies),
        total_zaps: parseInt(posts.total_zaps),
        total_sats: parseInt(posts.total_sats),
        avg_per_post: parseFloat(engagement.avg_engagement).toFixed(2)
      },
      last_updated: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Metrics summary error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch metrics'
    });
  }
});

/**
 * Get follower growth
 * GET /metrics/followers?period=7d
 */
app.get('/metrics/followers', auth.authenticate, auth.rateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const period = req.query.period || '7d';
    
    // Parse period
    let interval;
    switch (period) {
      case '24h': interval = '1 day'; break;
      case '7d': interval = '7 days'; break;
      case '30d': interval = '30 days'; break;
      case 'all': interval = '100 years'; break; // hack for "all time"
      default: interval = '7 days';
    }
    
    const result = await db.query(
      `SELECT 
         DATE(followed_at) as date,
         COUNT(*) as new_followers
       FROM followers
       WHERE user_id = $1 AND followed_at > NOW() - INTERVAL '${interval}'
       GROUP BY DATE(followed_at)
       ORDER BY date ASC`,
      [userId]
    );
    
    const totalResult = await db.query(
      'SELECT COUNT(*) as total FROM followers WHERE user_id = $1',
      [userId]
    );
    
    res.json({
      period,
      total_followers: parseInt(totalResult.rows[0].total),
      daily_breakdown: result.rows.map(row => ({
        date: row.date,
        new_followers: parseInt(row.new_followers)
      }))
    });
    
  } catch (error) {
    console.error('Follower metrics error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch follower data'
    });
  }
});

/**
 * Get recent posts with engagement
 * GET /metrics/posts?limit=10&sort=recent
 */
app.get('/metrics/posts', auth.authenticate, auth.rateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const sort = req.query.sort || 'recent';
    
    let orderBy;
    switch (sort) {
      case 'engagement':
        orderBy = '(likes + reposts + replies) DESC';
        break;
      case 'zaps':
        orderBy = 'zaps_sats DESC';
        break;
      default:
        orderBy = 'posted_at DESC';
    }
    
    const result = await db.query(
      `SELECT 
         note_id,
         content,
         likes,
         reposts,
         replies,
         zaps_count,
         zaps_sats,
         impressions,
         posted_at
       FROM posts
       WHERE user_id = $1
       ORDER BY ${orderBy}
       LIMIT $2`,
      [userId, limit]
    );
    
    res.json({
      posts: result.rows.map(post => ({
        note_id: post.note_id,
        content: post.content,
        engagement: {
          likes: post.likes,
          reposts: post.reposts,
          replies: post.replies,
          zaps_count: post.zaps_count,
          zaps_sats: parseInt(post.zaps_sats),
          impressions: post.impressions
        },
        posted_at: post.posted_at
      }))
    });
    
  } catch (error) {
    console.error('Posts metrics error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch posts'
    });
  }
});

/**
 * Get top engagers
 * GET /network/top-engagers?limit=10
 */
app.get('/network/top-engagers', auth.authenticate, auth.rateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    
    const result = await db.query(
      `SELECT 
         engager_npub,
         engager_name,
         interactions,
         last_interaction
       FROM engagers
       WHERE user_id = $1
       ORDER BY interactions DESC
       LIMIT $2`,
      [userId, limit]
    );
    
    res.json({
      top_engagers: result.rows.map(e => ({
        npub: e.engager_npub,
        name: e.engager_name,
        interactions: e.interactions,
        last_interaction: e.last_interaction
      }))
    });
    
  } catch (error) {
    console.error('Top engagers error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch top engagers'
    });
  }
});

/**
 * Get network activity timing data
 * GET /metrics/timing/network-activity?type=all&period=30d
 */
app.get('/metrics/timing/network-activity', auth.authenticate, auth.rateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const type = req.query.type || 'all'; // followers | following | engagement | all
    const period = req.query.period || '30d'; // 24h | 7d | 30d | 6m
    
    // Validate inputs
    const validTypes = ['followers', 'following', 'engagement', 'all'];
    const validPeriods = ['24h', '7d', '30d', '6m'];
    
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: 'Invalid type',
        message: `Type must be one of: ${validTypes.join(', ')}`
      });
    }
    
    if (!validPeriods.includes(period)) {
      return res.status(400).json({
        error: 'Invalid period',
        message: `Period must be one of: ${validPeriods.join(', ')}`
      });
    }
    
    // Try to get from cache first
    const cacheKey = `network_activity_${type}_${period}`;
    const cached = await timingAnalytics.getCachedInsight(userId, cacheKey, period);
    
    if (cached) {
      return res.json({
        ...cached,
        cached: true
      });
    }
    
    // Aggregate recent data
    await timingAnalytics.aggregateHourlyActivity(userId, period);
    
    // Get activity data
    const activityData = await timingAnalytics.getNetworkActivity(userId, type, period);
    
    // Cache for 1 hour
    await timingAnalytics.cacheInsight(userId, cacheKey, activityData, period, 1);
    
    res.json({
      ...activityData,
      cached: false
    });
    
  } catch (error) {
    console.error('Network activity error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch network activity'
    });
  }
});

/**
 * Get best posting times with recommendations
 * GET /insights/best-posting-times?period=30d
 */
app.get('/insights/best-posting-times', auth.authenticate, auth.rateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const period = req.query.period || '30d';
    
    // Validate period
    const validPeriods = ['24h', '7d', '30d', '6m'];
    if (!validPeriods.includes(period)) {
      return res.status(400).json({
        error: 'Invalid period',
        message: `Period must be one of: ${validPeriods.join(', ')}`
      });
    }
    
    // Try cache first (4 hour TTL for insights)
    const cached = await timingAnalytics.getCachedInsight(userId, 'best_posting_times', period);
    
    if (cached) {
      return res.json({
        ...cached,
        cached: true
      });
    }
    
    // Aggregate recent data
    await timingAnalytics.aggregateHourlyActivity(userId, period);
    
    // Calculate best posting times
    const insights = await timingAnalytics.getBestPostingTimes(userId, period);
    
    // Cache for 4 hours
    await timingAnalytics.cacheInsight(userId, 'best_posting_times', insights, period, 4);
    
    res.json({
      ...insights,
      cached: false
    });
    
  } catch (error) {
    console.error('Best posting times error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to calculate best posting times'
    });
  }
});

/**
 * Manually trigger activity aggregation
 * POST /admin/aggregate-activity
 */
app.post('/admin/aggregate-activity', auth.authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const period = req.body.period || '30d';
    
    await timingAnalytics.aggregateHourlyActivity(userId, period);
    
    res.json({
      success: true,
      message: `Activity aggregated for period: ${period}`
    });
    
  } catch (error) {
    console.error('Aggregation error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to aggregate activity'
    });
  }
});

/**
 * Scan user's network to populate timing data
 * POST /admin/scan-network
 * 
 * This fetches recent posts from accounts the user follows
 * to bootstrap timing analytics without waiting for passive collection.
 */
app.post('/admin/scan-network', auth.authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userNpub = req.user.npub;
    const period = req.body.period || '30d';
    
    // Validate period
    const validPeriods = ['7d', '30d', '90d'];
    if (!validPeriods.includes(period)) {
      return res.status(400).json({
        error: 'Invalid period',
        message: `Period must be one of: ${validPeriods.join(', ')}`
      });
    }
    
    console.log(`[API] Starting network scan for user ${userId} (${userNpub})`);
    
    // Run the scan
    const result = await networkScanner.scanUserNetwork(userId, userNpub, period);
    
    if (!result.success) {
      return res.status(400).json({
        error: 'Scan failed',
        message: result.error,
        ...result
      });
    }
    
    // Clear any cached insights so fresh data is used
    await db.query(
      `DELETE FROM insights WHERE user_id = $1`,
      [userId]
    );
    
    res.json({
      success: true,
      message: 'Network scan complete',
      ...result
    });
    
  } catch (error) {
    console.error('Network scan error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to scan network: ' + error.message
    });
  }
});

/**
 * Quick scan - get activity distribution without storing (faster)
 * GET /metrics/timing/quick-scan?period=30d
 * 
 * For users who want instant results without account registration.
 * Requires npub in query string.
 */
app.get('/metrics/timing/quick-scan', async (req, res) => {
  try {
    const npub = req.query.npub;
    const period = req.query.period || '30d';
    
    if (!npub) {
      return res.status(400).json({
        error: 'Missing npub',
        message: 'Provide npub query parameter'
      });
    }
    
    const validPeriods = ['7d', '30d'];
    if (!validPeriods.includes(period)) {
      return res.status(400).json({
        error: 'Invalid period',
        message: `Period must be one of: ${validPeriods.join(', ')}`
      });
    }
    
    console.log(`[API] Quick scan for ${npub} (${period})`);
    
    const result = await networkScanner.quickScanNetwork(npub, period);
    
    res.json({
      ...result,
      current_time_gmt: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('Quick scan error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to scan network: ' + error.message
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
const PORT = config.server.port;
app.listen(PORT, () => {
  console.log(`🦞 Deep Claw Analytics API running on port ${PORT}`);
  console.log(`Environment: ${config.server.env}`);
});

module.exports = app;
