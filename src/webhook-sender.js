/**
 * Webhook Sender
 * Sends events to user OpenClaw instances
 */

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

/**
 * Sign webhook payload
 */
function signPayload(payload, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  return hmac.update(JSON.stringify(payload)).digest('hex');
}

/**
 * Send webhook to user's OpenClaw instance
 */
async function sendWebhook(userId, eventType, payload) {
  try {
    // Get user webhook config
    const result = await db.query(
      'SELECT webhook_url, webhook_secret FROM users WHERE id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      console.error(`User ${userId} not found`);
      return false;
    }
    
    const { webhook_url, webhook_secret } = result.rows[0];
    
    // Add event metadata
    const fullPayload = {
      event_type: eventType,
      timestamp: Math.floor(Date.now() / 1000),
      ...payload
    };
    
    // Sign payload
    const signature = signPayload(fullPayload, webhook_secret);
    
    // Send webhook
    const response = await fetch(webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Deep-Claw-Signature': signature,
        'User-Agent': 'DeepClaw-Analytics/1.0'
      },
      body: JSON.stringify(fullPayload),
      signal: AbortSignal.timeout(config.webhooks.timeout)
    });
    
    // Log webhook
    await db.query(
      `INSERT INTO webhook_logs (user_id, event_type, payload, status, response_code, sent_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        userId,
        eventType,
        JSON.stringify(fullPayload),
        response.ok ? 'sent' : 'failed',
        response.status
      ]
    );
    
    if (response.ok) {
      console.log(`✅ Webhook sent to user ${userId}: ${eventType}`);
      return true;
    } else {
      console.error(`❌ Webhook failed for user ${userId}: ${response.status}`);
      return false;
    }
    
  } catch (error) {
    console.error(`Webhook error for user ${userId}:`, error.message);
    
    // Log failed webhook
    await db.query(
      `INSERT INTO webhook_logs (user_id, event_type, payload, status, error_message, sent_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        userId,
        eventType,
        JSON.stringify(payload),
        'failed',
        error.message
      ]
    );
    
    return false;
  }
}

/**
 * Send mention webhook
 */
async function sendMentionWebhook(userId, event) {
  const payload = {
    author: {
      npub: event.pubkey,
      display_name: event.pubkey.substring(0, 8) + '...' // TODO: fetch profile
    },
    content: event.content,
    note_id: event.id,
    created_at: event.created_at
  };
  
  return sendWebhook(userId, 'mention', payload);
}

/**
 * Send new follower webhook
 */
async function sendFollowerWebhook(userId, event) {
  // Get total follower count
  const result = await db.query(
    'SELECT COUNT(*) as total FROM followers WHERE user_id = $1',
    [userId]
  );
  
  const payload = {
    follower: {
      npub: event.pubkey,
      display_name: event.pubkey.substring(0, 8) + '...' // TODO: fetch profile
    },
    total_followers: parseInt(result.rows[0].total)
  };
  
  return sendWebhook(userId, 'new_follower', payload);
}

/**
 * Send zap webhook
 */
async function sendZapWebhook(userId, event, amountSats) {
  const payload = {
    from: {
      npub: event.pubkey,
      display_name: event.pubkey.substring(0, 8) + '...'
    },
    amount_sats: amountSats,
    message: event.content || '',
    note_id: event.id
  };
  
  return sendWebhook(userId, 'zap', payload);
}

/**
 * Send daily summary webhook
 */
async function sendDailySummary(userId) {
  try {
    // Calculate stats for last 24h
    const followersResult = await db.query(
      `SELECT COUNT(*) as new_followers 
       FROM followers 
       WHERE user_id = $1 AND followed_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    
    const totalFollowersResult = await db.query(
      'SELECT COUNT(*) as total FROM followers WHERE user_id = $1',
      [userId]
    );
    
    const postsResult = await db.query(
      `SELECT COUNT(*) as posts 
       FROM posts 
       WHERE user_id = $1 AND posted_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    
    const engagementResult = await db.query(
      `SELECT 
         COALESCE(SUM(likes), 0) as likes,
         COALESCE(SUM(reposts), 0) as reposts,
         COALESCE(SUM(replies), 0) as replies,
         COALESCE(SUM(zaps_sats), 0) as sats
       FROM posts 
       WHERE user_id = $1 AND posted_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    
    const payload = {
      date: new Date().toISOString().split('T')[0],
      stats: {
        new_followers: parseInt(followersResult.rows[0].new_followers),
        total_followers: parseInt(totalFollowersResult.rows[0].total),
        posts: parseInt(postsResult.rows[0].posts),
        likes: parseInt(engagementResult.rows[0].likes),
        reposts: parseInt(engagementResult.rows[0].reposts),
        replies: parseInt(engagementResult.rows[0].replies),
        zaps_sats: parseInt(engagementResult.rows[0].sats)
      }
    };
    
    return sendWebhook(userId, 'daily_summary', payload);
    
  } catch (error) {
    console.error('Failed to send daily summary:', error);
    return false;
  }
}

/**
 * Send daily summaries to all users
 */
async function sendAllDailySummaries() {
  try {
    const result = await db.query('SELECT id FROM users');
    
    for (const user of result.rows) {
      await sendDailySummary(user.id);
      // Small delay to avoid hammering
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`📊 Sent daily summaries to ${result.rows.length} users`);
  } catch (error) {
    console.error('Failed to send daily summaries:', error);
  }
}

module.exports = {
  sendWebhook,
  sendMentionWebhook,
  sendFollowerWebhook,
  sendZapWebhook,
  sendDailySummary,
  sendAllDailySummaries
};
