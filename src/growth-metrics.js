/**
 * Growth Metrics & Follow Suggestions
 * Track account growth and provide smart follow recommendations
 */

const db = require('./db');

/**
 * GET /network/follow-suggestions
 * Get smart recommendations for who to follow
 */
async function getFollowSuggestions(req, res) {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;
    const filters = req.query.filters ? req.query.filters.split(',') : ['active', 'quality'];
    
    // Get suggestions based on:
    // 1. Who your followers follow (mutual connections)
    // 2. Who engages with your content
    // 3. Active posters in your network's topics
    
    const query = `
      WITH my_following AS (
        SELECT following_npub FROM following WHERE user_id = $1
      ),
      potential_follows AS (
        -- People who engage with me but I don't follow
        SELECT DISTINCT
          e.author_npub as npub,
          e.author_name as name,
          e.metadata->>'bio' as bio,
          (e.metadata->>'follower_count')::int as follower_count,
          COUNT(*) as engagement_count,
          MAX(e.created_at) as last_engagement,
          'engaged_with_you' as source
        FROM events e
        WHERE e.user_id = $1
          AND e.event_type IN ('like', 'reply', 'zap', 'repost')
          AND e.author_npub NOT IN (SELECT following_npub FROM my_following)
          AND e.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY e.author_npub, e.author_name, e.metadata->>'bio', e.metadata->>'follower_count'
        
        UNION ALL
        
        -- Followers I don't follow back
        SELECT DISTINCT
          e.author_npub as npub,
          e.author_name as name,
          e.metadata->>'bio' as bio,
          (e.metadata->>'follower_count')::int as follower_count,
          1 as engagement_count,
          e.created_at as last_engagement,
          'follower_not_followed' as source
        FROM events e
        WHERE e.user_id = $1
          AND e.event_type = 'follow'
          AND e.author_npub NOT IN (SELECT following_npub FROM my_following)
          AND e.created_at >= NOW() - INTERVAL '90 days'
      ),
      scored AS (
        SELECT 
          npub,
          name,
          bio,
          MAX(follower_count) as follower_count,
          SUM(engagement_count) as total_engagement,
          MAX(last_engagement) as last_engagement,
          array_agg(DISTINCT source) as sources,
          -- Score calculation:
          -- Base score from follower count (log scale)
          -- + engagement bonus
          -- + recency bonus
          (
            LEAST(LOG(COALESCE(MAX(follower_count), 1) + 1) / 5, 0.3) +
            LEAST(SUM(engagement_count) * 0.1, 0.4) +
            CASE 
              WHEN MAX(last_engagement) >= NOW() - INTERVAL '7 days' THEN 0.3
              WHEN MAX(last_engagement) >= NOW() - INTERVAL '30 days' THEN 0.2
              ELSE 0.1
            END
          ) as score
        FROM potential_follows
        GROUP BY npub, name, bio
      )
      SELECT 
        npub,
        name,
        bio,
        follower_count,
        total_engagement,
        last_engagement,
        sources,
        ROUND(score::numeric, 2) as score
      FROM scored
      WHERE npub IS NOT NULL
      ORDER BY score DESC
      LIMIT $2
    `;
    
    const result = await db.query(query, [userId, limit]);
    
    // Get mutual follower counts for each suggestion
    const suggestions = await Promise.all(result.rows.map(async (row) => {
      // Count mutual followers (people we both follow)
      const mutualQuery = `
        SELECT COUNT(DISTINCT f1.following_npub) as mutual_count
        FROM following f1
        JOIN following f2 ON f1.following_npub = f2.following_npub
        WHERE f1.user_id = $1
          AND f2.user_id IN (
            SELECT id FROM users WHERE npub = $2
          )
      `;
      
      let mutualFollowers = 0;
      try {
        const mutualResult = await db.query(mutualQuery, [userId, row.npub]);
        mutualFollowers = parseInt(mutualResult.rows[0]?.mutual_count) || 0;
      } catch (e) {
        // Ignore if we can't get mutual count
      }
      
      // Get recent post
      const recentPostQuery = `
        SELECT content
        FROM posts
        WHERE user_id IN (SELECT id FROM users WHERE npub = $1)
        ORDER BY posted_at DESC
        LIMIT 1
      `;
      
      let recentPost = null;
      try {
        const recentResult = await db.query(recentPostQuery, [row.npub]);
        recentPost = recentResult.rows[0]?.content;
      } catch (e) {
        // Ignore if we can't get recent post
      }
      
      // Generate reason based on sources
      const reasons = [];
      if (row.sources.includes('engaged_with_you')) {
        reasons.push(`Engaged with you ${row.total_engagement} times`);
      }
      if (row.sources.includes('follower_not_followed')) {
        reasons.push('Follows you');
      }
      if (row.follower_count > 1000) {
        reasons.push(`${row.follower_count.toLocaleString()} followers`);
      }
      if (mutualFollowers > 0) {
        reasons.push(`${mutualFollowers} mutual connections`);
      }
      
      return {
        npub: row.npub,
        name: row.name || 'Unknown',
        bio: row.bio,
        followerCount: row.follower_count || 0,
        mutualFollowers,
        recentPost: recentPost ? recentPost.slice(0, 150) + (recentPost.length > 150 ? '...' : '') : null,
        score: parseFloat(row.score) || 0,
        reason: reasons.join(', ') || 'Recommended based on network analysis'
      };
    }));
    
    res.json({ suggestions });
    
  } catch (error) {
    console.error('Get follow suggestions error:', error);
    res.status(500).json({
      error: 'Failed to get follow suggestions',
      message: error.message
    });
  }
}

/**
 * POST /events/acknowledge
 * Mark events as seen/processed
 */
async function acknowledgeEvents(req, res) {
  try {
    const userId = req.user.id;
    const { eventIds } = req.body;
    
    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'eventIds must be a non-empty array'
      });
    }
    
    // Update events to processed (using existing schema)
    const result = await db.query(`
      UPDATE events
      SET processed = true
      WHERE user_id = $1
        AND id = ANY($2::int[])
        AND processed = false
      RETURNING id
    `, [userId, eventIds]);
    
    // Get remaining unprocessed count
    const remainingResult = await db.query(`
      SELECT COUNT(*) as remaining
      FROM events
      WHERE user_id = $1
        AND processed = false
    `, [userId]);
    
    res.json({
      acknowledged: result.rows.length,
      remaining: parseInt(remainingResult.rows[0]?.remaining) || 0
    });
    
  } catch (error) {
    console.error('Acknowledge events error:', error);
    res.status(500).json({
      error: 'Failed to acknowledge events',
      message: error.message
    });
  }
}

/**
 * GET /metrics/growth
 * Track account growth over time
 */
async function getGrowthMetrics(req, res) {
  try {
    const userId = req.user.id;
    const period = req.query.period || '30d';
    const granularity = req.query.granularity || 'daily';
    
    // Convert period to days
    const periodDays = {
      '7d': 7,
      '30d': 30,
      '90d': 90
    };
    const days = periodDays[period] || 30;
    
    // Determine date truncation based on granularity
    const dateTrunc = granularity === 'weekly' ? 'week' : 'day';
    
    // Get daily metrics
    const timelineQuery = `
      WITH date_series AS (
        SELECT generate_series(
          DATE_TRUNC('${dateTrunc}', NOW() - INTERVAL '${days} days'),
          DATE_TRUNC('${dateTrunc}', NOW()),
          INTERVAL '1 ${dateTrunc}'
        )::date as date
      ),
      daily_followers AS (
        SELECT 
          DATE_TRUNC('${dateTrunc}', created_at)::date as date,
          COUNT(*) as new_followers
        FROM events
        WHERE user_id = $1
          AND event_type = 'follow'
          AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY date
      ),
      daily_posts AS (
        SELECT 
          DATE_TRUNC('${dateTrunc}', posted_at)::date as date,
          COUNT(*) as posts_count
        FROM posts
        WHERE user_id = $1
          AND posted_at >= NOW() - INTERVAL '${days} days'
        GROUP BY date
      ),
      daily_engagement AS (
        SELECT 
          DATE_TRUNC('${dateTrunc}', created_at)::date as date,
          COUNT(CASE WHEN event_type = 'like' THEN 1 END) as reactions,
          COUNT(CASE WHEN event_type = 'reply' THEN 1 END) as replies,
          SUM(CASE WHEN event_type = 'zap' THEN (metadata->>'amount_sats')::int ELSE 0 END) as zaps_sats
        FROM events
        WHERE user_id = $1
          AND event_type IN ('like', 'reply', 'zap')
          AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY date
      )
      SELECT 
        ds.date,
        COALESCE(df.new_followers, 0) as followers,
        COALESCE(dp.posts_count, 0) as posts,
        COALESCE(de.reactions, 0) + COALESCE(de.replies, 0) as total_reactions,
        COALESCE(de.zaps_sats, 0) as total_zaps_sats
      FROM date_series ds
      LEFT JOIN daily_followers df ON df.date = ds.date
      LEFT JOIN daily_posts dp ON dp.date = ds.date
      LEFT JOIN daily_engagement de ON de.date = ds.date
      ORDER BY ds.date ASC
    `;
    
    const timelineResult = await db.query(timelineQuery, [userId]);
    
    // Calculate engagement rate (reactions / impressions)
    const timeline = timelineResult.rows.map(row => ({
      date: row.date,
      followers: parseInt(row.followers) || 0,
      posts: parseInt(row.posts) || 0,
      totalReactions: parseInt(row.total_reactions) || 0,
      totalZapsSats: parseInt(row.total_zaps_sats) || 0,
      // Rough engagement rate calculation
      engagementRate: row.posts > 0 
        ? parseFloat(((row.total_reactions || 0) / Math.max(row.posts * 100, 1)).toFixed(3))
        : 0
    }));
    
    // Calculate trends
    const recentDays = 7;
    const recentTimeline = timeline.slice(-recentDays);
    const previousTimeline = timeline.slice(-recentDays * 2, -recentDays);
    
    const recentFollowers = recentTimeline.reduce((sum, d) => sum + d.followers, 0);
    const previousFollowers = previousTimeline.reduce((sum, d) => sum + d.followers, 0);
    
    const recentEngagement = recentTimeline.reduce((sum, d) => sum + d.totalReactions, 0);
    const previousEngagement = previousTimeline.reduce((sum, d) => sum + d.totalReactions, 0);
    
    // Get top performing post
    const topPostQuery = `
      SELECT 
        note_id as id,
        content,
        reactions + replies + reposts as total_engagement,
        reactions,
        replies,
        reposts
      FROM posts
      WHERE user_id = $1
        AND posted_at >= NOW() - INTERVAL '${days} days'
      ORDER BY total_engagement DESC
      LIMIT 1
    `;
    
    const topPostResult = await db.query(topPostQuery, [userId]);
    
    const topPost = topPostResult.rows[0] ? {
      id: topPostResult.rows[0].id,
      content: topPostResult.rows[0].content?.slice(0, 100) + (topPostResult.rows[0].content?.length > 100 ? '...' : ''),
      reactions: parseInt(topPostResult.rows[0].reactions) || 0,
      replies: parseInt(topPostResult.rows[0].replies) || 0,
      reposts: parseInt(topPostResult.rows[0].reposts) || 0
    } : null;
    
    // Calculate follower growth
    let followerGrowth = '';
    const followerDiff = recentFollowers - previousFollowers;
    if (followerDiff > 0) {
      followerGrowth = `+${recentFollowers} (${recentDays} days)`;
    } else if (followerDiff < 0) {
      followerGrowth = `${recentFollowers} (${recentDays} days)`;
    } else {
      followerGrowth = `${recentFollowers} (${recentDays} days)`;
    }
    
    // Determine engagement trend
    let engagementTrend = 'stable';
    if (recentEngagement > previousEngagement * 1.1) {
      engagementTrend = 'increasing';
    } else if (recentEngagement < previousEngagement * 0.9) {
      engagementTrend = 'decreasing';
    }
    
    res.json({
      timeline,
      trends: {
        followerGrowth,
        engagementTrend,
        topPost
      },
      summary: {
        totalFollowersGained: timeline.reduce((sum, d) => sum + d.followers, 0),
        totalPosts: timeline.reduce((sum, d) => sum + d.posts, 0),
        totalReactions: timeline.reduce((sum, d) => sum + d.totalReactions, 0),
        totalZapsSats: timeline.reduce((sum, d) => sum + d.totalZapsSats, 0),
        period,
        granularity
      }
    });
    
  } catch (error) {
    console.error('Get growth metrics error:', error);
    res.status(500).json({
      error: 'Failed to get growth metrics',
      message: error.message
    });
  }
}

module.exports = {
  getFollowSuggestions,
  acknowledgeEvents,
  getGrowthMetrics
};
