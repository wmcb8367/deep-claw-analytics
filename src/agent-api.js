/**
 * Agent API - Endpoints for AI agents managing Nostr accounts
 * Provides high-level insights and recommendations for account management
 */

const db = require('./db');

/**
 * GET /events/activity
 * Get all new activity since last check (reactions, replies, mentions, zaps, follows)
 */
async function getActivity(req, res) {
  try {
    const userId = req.user.id;
    const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const types = req.query.types ? req.query.types.split(',') : ['reaction', 'reply', 'mention', 'zap', 'follow'];
    
    // Query events table for activity since timestamp
    const query = `
      SELECT 
        e.id,
        e.type,
        e.event_data->>'id' as post_id,
        e.event_data->>'content' as post_content,
        e.event_data->>'pubkey' as from_user,
        e.event_data->>'author_name' as from_user_name,
        e.event_data->>'emoji' as emoji,
        e.event_data->>'reply_content' as reply_content,
        e.event_data->>'amount_sats' as amount_sats,
        e.event_data->>'message' as message,
        e.created_at as timestamp
      FROM events e
      WHERE e.user_id = $1
        AND e.created_at >= $2
        AND e.type = ANY($3)
        AND e.acknowledged = false
      ORDER BY e.created_at DESC
    `;
    
    const result = await db.query(query, [userId, since, types]);
    
    const events = result.rows.map(row => {
      const event = {
        id: row.id,
        type: row.type,
        postId: row.post_id,
        fromUser: row.from_user,
        fromUserName: row.from_user_name,
        timestamp: row.timestamp
      };
      
      // Add type-specific fields
      if (row.type === 'reaction') {
        event.postContent = row.post_content;
        event.emoji = row.emoji;
      } else if (row.type === 'reply') {
        event.postContent = row.post_content;
        event.replyContent = row.reply_content;
      } else if (row.type === 'zap') {
        event.postId = row.post_id;
        event.amountSats = parseInt(row.amount_sats) || 0;
        event.message = row.message;
      } else if (row.type === 'mention') {
        event.postContent = row.post_content;
      }
      
      return event;
    });
    
    res.json({
      events,
      unreadCount: events.length
    });
    
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({
      error: 'Failed to get activity',
      message: error.message
    });
  }
}

/**
 * GET /posts/performance
 * Get engagement metrics for recent posts
 */
async function getPostsPerformance(req, res) {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 20;
    const include = req.query.include ? req.query.include.split(',') : ['metrics', 'top_engagers'];
    
    // Query for user's recent posts with aggregated metrics
    const query = `
      WITH post_metrics AS (
        SELECT 
          p.note_id,
          p.content,
          p.posted_at as timestamp,
          p.image_url,
          COUNT(DISTINCT CASE WHEN e.type = 'reaction' THEN e.id END) as reactions,
          COUNT(DISTINCT CASE WHEN e.type = 'reply' THEN e.id END) as replies,
          COUNT(DISTINCT CASE WHEN e.type = 'repost' THEN e.id END) as reposts,
          COUNT(DISTINCT CASE WHEN e.type = 'zap' THEN e.id END) as zap_count,
          COALESCE(SUM(CASE WHEN e.type = 'zap' THEN (e.event_data->>'amount_sats')::int ELSE 0 END), 0) as total_sats,
          p.impressions
        FROM posts p
        LEFT JOIN events e ON e.event_data->>'post_id' = p.note_id AND e.user_id = p.user_id
        WHERE p.user_id = $1
        GROUP BY p.note_id, p.content, p.posted_at, p.image_url, p.impressions
        ORDER BY p.posted_at DESC
        LIMIT $2
      )
      SELECT 
        pm.*,
        CASE 
          WHEN pm.impressions > 0 
          THEN ROUND((pm.reactions + pm.replies + pm.reposts + pm.zap_count)::numeric / pm.impressions::numeric, 4)
          ELSE 0 
        END as engagement_rate
      FROM post_metrics pm
    `;
    
    const result = await db.query(query, [userId, limit]);
    
    const posts = await Promise.all(result.rows.map(async (row) => {
      const post = {
        id: row.note_id,
        content: row.content,
        timestamp: row.timestamp,
        imageUrl: row.image_url
      };
      
      if (include.includes('metrics')) {
        post.metrics = {
          reactions: parseInt(row.reactions) || 0,
          replies: parseInt(row.replies) || 0,
          reposts: parseInt(row.reposts) || 0,
          zaps: {
            count: parseInt(row.zap_count) || 0,
            totalSats: parseInt(row.total_sats) || 0
          },
          impressions: parseInt(row.impressions) || 0,
          engagementRate: parseFloat(row.engagement_rate) || 0
        };
      }
      
      if (include.includes('top_engagers')) {
        // Get top engagers for this post
        const engagersQuery = `
          SELECT 
            e.event_data->>'pubkey' as npub,
            e.event_data->>'author_name' as name,
            e.type as action,
            CASE 
              WHEN e.type = 'zap' THEN (e.event_data->>'amount_sats')::int
              ELSE NULL 
            END as value
          FROM events e
          WHERE e.user_id = $1 
            AND e.event_data->>'post_id' = $2
            AND e.type IN ('reaction', 'reply', 'zap', 'repost')
          ORDER BY e.created_at DESC
          LIMIT 5
        `;
        
        const engagersResult = await db.query(engagersQuery, [userId, row.note_id]);
        post.topEngagers = engagersResult.rows.map(eng => ({
          npub: eng.npub,
          name: eng.name,
          action: eng.action,
          value: eng.value
        }));
      }
      
      return post;
    }));
    
    res.json({ posts });
    
  } catch (error) {
    console.error('Get posts performance error:', error);
    res.status(500).json({
      error: 'Failed to get posts performance',
      message: error.message
    });
  }
}

/**
 * GET /insights/top-engagers
 * Get users who consistently interact with your content
 */
async function getTopEngagers(req, res) {
  try {
    const userId = req.user.id;
    const period = req.query.period || '7d';
    const minInteractions = parseInt(req.query.min_interactions) || 2;
    
    // Convert period to days
    const periodDays = {
      '7d': 7,
      '30d': 30,
      '90d': 90
    };
    const days = periodDays[period] || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const query = `
      WITH engager_stats AS (
        SELECT 
          e.event_data->>'pubkey' as npub,
          e.event_data->>'author_name' as name,
          e.event_data->>'follower_count' as follower_count,
          COUNT(*) as total_interactions,
          COUNT(CASE WHEN e.type = 'zap' THEN 1 END) as zaps,
          COUNT(CASE WHEN e.type = 'reply' THEN 1 END) as replies,
          COUNT(CASE WHEN e.type = 'reaction' THEN 1 END) as reactions,
          COALESCE(SUM(CASE WHEN e.type = 'zap' THEN (e.event_data->>'amount_sats')::int ELSE 0 END), 0) as total_sats_zapped,
          MAX(e.created_at) as last_interaction
        FROM events e
        WHERE e.user_id = $1
          AND e.created_at >= $2
          AND e.type IN ('zap', 'reply', 'reaction', 'repost')
        GROUP BY npub, name, follower_count
        HAVING COUNT(*) >= $3
        ORDER BY total_interactions DESC, total_sats_zapped DESC
        LIMIT 50
      )
      SELECT 
        es.*,
        CASE WHEN f.following_npub IS NOT NULL THEN true ELSE false END as following
      FROM engager_stats es
      LEFT JOIN following f ON f.following_npub = es.npub AND f.user_id = $1
    `;
    
    const result = await db.query(query, [userId, since, minInteractions]);
    
    const topEngagers = result.rows.map(row => ({
      npub: row.npub,
      name: row.name,
      followerCount: parseInt(row.follower_count) || 0,
      interactions: {
        total: parseInt(row.total_interactions) || 0,
        zaps: parseInt(row.zaps) || 0,
        replies: parseInt(row.replies) || 0,
        reactions: parseInt(row.reactions) || 0
      },
      totalSatsZapped: parseInt(row.total_sats_zapped) || 0,
      lastInteraction: row.last_interaction,
      following: row.following
    }));
    
    res.json({ topEngagers });
    
  } catch (error) {
    console.error('Get top engagers error:', error);
    res.status(500).json({
      error: 'Failed to get top engagers',
      message: error.message
    });
  }
}

/**
 * GET /insights/should-engage
 * Smart recommendations for who to engage with
 */
async function getShouldEngage(req, res) {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;
    
    // Get recent unacknowledged replies and mentions
    const repliesQuery = `
      SELECT 
        e.id,
        e.event_data->>'pubkey' as npub,
        e.event_data->>'author_name' as name,
        e.event_data->>'post_id' as post_id,
        e.event_data->>'reply_content' as reply_content,
        e.event_data->>'reply_id' as reply_id,
        e.event_data->>'follower_count' as follower_count,
        e.created_at
      FROM events e
      WHERE e.user_id = $1
        AND e.type = 'reply'
        AND e.acknowledged = false
        AND e.created_at >= NOW() - INTERVAL '7 days'
      ORDER BY e.created_at DESC
      LIMIT $2
    `;
    
    // Get new followers
    const followersQuery = `
      SELECT 
        e.id,
        e.event_data->>'pubkey' as npub,
        e.event_data->>'author_name' as name,
        e.event_data->>'follower_count' as follower_count,
        e.event_data->>'bio' as bio,
        e.created_at
      FROM events e
      WHERE e.user_id = $1
        AND e.type = 'follow'
        AND e.acknowledged = false
        AND e.created_at >= NOW() - INTERVAL '7 days'
      ORDER BY e.created_at DESC
      LIMIT $2
    `;
    
    const [repliesResult, followersResult] = await Promise.all([
      db.query(repliesQuery, [userId, limit]),
      db.query(followersQuery, [userId, Math.floor(limit / 2)])
    ]);
    
    const recommendations = [];
    
    // Process replies
    for (const row of repliesResult.rows) {
      recommendations.push({
        npub: row.npub,
        name: row.name,
        reason: `Replied to your post`,
        replyContent: row.reply_content,
        replyId: row.reply_id,
        followerCount: parseInt(row.follower_count) || 0,
        priority: 'high',
        suggestedAction: 'reply_back',
        timestamp: row.created_at
      });
    }
    
    // Process new followers
    for (const row of followersResult.rows) {
      const followerCount = parseInt(row.follower_count) || 0;
      const priority = followerCount > 500 ? 'high' : followerCount > 100 ? 'medium' : 'low';
      
      recommendations.push({
        npub: row.npub,
        name: row.name,
        reason: followerCount > 500 
          ? `Influential user (${followerCount} followers) started following you`
          : 'Started following you',
        followerCount: followerCount,
        bio: row.bio,
        priority: priority,
        suggestedAction: 'welcome_follow',
        timestamp: row.created_at
      });
    }
    
    // Sort by priority and timestamp
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    recommendations.sort((a, b) => {
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
    
    res.json({
      recommendations: recommendations.slice(0, limit)
    });
    
  } catch (error) {
    console.error('Get should engage error:', error);
    res.status(500).json({
      error: 'Failed to get engagement recommendations',
      message: error.message
    });
  }
}

/**
 * GET /insights/posting-strategy
 * When and what to post for optimal engagement
 */
async function getPostingStrategy(req, res) {
  try {
    const userId = req.user.id;
    const include = req.query.include ? req.query.include.split(',') : ['timing', 'content_mix'];
    
    const response = {};
    
    // 1. Optimal posting times from timing analytics
    if (include.includes('timing')) {
      // Get zone of max participation from network_activity
      const timingQuery = `
        SELECT 
          activity_type,
          hour_gmt,
          activity_count
        FROM network_activity
        WHERE user_id = $1
          AND activity_type = 'following_post'
        ORDER BY activity_count DESC
        LIMIT 24
      `;
      
      const timingResult = await db.query(timingQuery, [userId]);
      
      // Calculate optimal windows
      const hourlyActivity = new Array(24).fill(0);
      for (const row of timingResult.rows) {
        hourlyActivity[row.hour_gmt] = parseInt(row.activity_count) || 0;
      }
      
      // Find top 3 hours
      const hourScores = hourlyActivity.map((count, hour) => ({ hour, count }));
      hourScores.sort((a, b) => b.count - a.count);
      const topHours = hourScores.slice(0, 3);
      
      // Get user's past post performance by hour
      const performanceQuery = `
        SELECT 
          EXTRACT(HOUR FROM posted_at AT TIME ZONE 'UTC') as hour,
          AVG(
            CASE 
              WHEN impressions > 0 
              THEN (reactions + replies + reposts)::float / impressions
              ELSE 0 
            END
          ) as avg_engagement_rate
        FROM posts
        WHERE user_id = $1
          AND posted_at >= NOW() - INTERVAL '30 days'
        GROUP BY hour
      `;
      
      const performanceResult = await db.query(performanceQuery, [userId]);
      const performanceByHour = {};
      for (const row of performanceResult.rows) {
        performanceByHour[row.hour] = parseFloat(row.avg_engagement_rate) || 0;
      }
      
      response.optimalTimes = topHours.map(({ hour, count }) => ({
        window: `${hour.toString().padStart(2, '0')}:00-${((hour + 1) % 24).toString().padStart(2, '0')}:00 GMT`,
        reason: `${count} network posts in this hour, ${Math.round((count / hourlyActivity.reduce((a, b) => a + b, 0)) * 100)}% of daily activity`,
        averageEngagement: performanceByHour[hour] || 0
      }));
    }
    
    // 2. Content mix analysis
    if (include.includes('content_mix')) {
      const contentQuery = `
        SELECT 
          CASE 
            WHEN content ~* 'https?://\\S+\\.(jpg|jpeg|png|gif|webp)' THEN 'image'
            WHEN content ~* 'https?://\\S+' THEN 'link'
            WHEN LENGTH(content) > 280 THEN 'long_form'
            ELSE 'text'
          END as content_type,
          COUNT(*) as post_count,
          AVG(reactions + replies + reposts) as avg_engagement,
          AVG(
            CASE 
              WHEN impressions > 0 
              THEN (reactions + replies + reposts)::float / impressions
              ELSE 0 
            END
          ) as avg_engagement_rate
        FROM posts
        WHERE user_id = $1
          AND posted_at >= NOW() - INTERVAL '30 days'
        GROUP BY content_type
        ORDER BY avg_engagement_rate DESC
      `;
      
      const contentResult = await db.query(contentQuery, [userId]);
      
      response.contentMix = {
        bestPerforming: contentResult.rows.map(row => ({
          type: row.content_type,
          postCount: parseInt(row.post_count) || 0,
          avgEngagement: parseFloat(row.avg_engagement) || 0,
          avgEngagementRate: parseFloat(row.avg_engagement_rate) || 0
        })),
        recommendation: contentResult.rows[0] 
          ? `Focus on ${contentResult.rows[0].content_type} posts - they get ${Math.round(contentResult.rows[0].avg_engagement_rate * 100)}% more engagement`
          : 'Post more varied content to gather data'
      };
    }
    
    // 3. Posting frequency analysis
    if (include.includes('frequency')) {
      const frequencyQuery = `
        WITH daily_posts AS (
          SELECT 
            DATE(posted_at) as post_date,
            COUNT(*) as posts_per_day,
            AVG(reactions + replies + reposts) as avg_engagement
          FROM posts
          WHERE user_id = $1
            AND posted_at >= NOW() - INTERVAL '30 days'
          GROUP BY post_date
        )
        SELECT 
          AVG(posts_per_day) as avg_posts_per_day,
          posts_per_day as optimal_frequency,
          avg_engagement
        FROM daily_posts
        ORDER BY avg_engagement DESC
        LIMIT 1
      `;
      
      const frequencyResult = await db.query(frequencyQuery, [userId]);
      
      if (frequencyResult.rows.length > 0) {
        const row = frequencyResult.rows[0];
        response.frequency = {
          current: parseFloat(row.avg_posts_per_day) || 0,
          optimal: parseInt(row.optimal_frequency) || 1,
          recommendation: `Post ${row.optimal_frequency} times per day for best engagement`
        };
      }
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('Get posting strategy error:', error);
    res.status(500).json({
      error: 'Failed to get posting strategy',
      message: error.message
    });
  }
}

module.exports = {
  getActivity,
  getPostsPerformance,
  getTopEngagers,
  getShouldEngage,
  getPostingStrategy
};
