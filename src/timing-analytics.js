/**
 * Timing Analytics Service
 * Analyzes network activity patterns to recommend optimal posting times
 */

const db = require('./db');

/**
 * Record post activity from network
 * @param {number} userId - User ID
 * @param {string} authorNpub - Author's npub
 * @param {string} authorType - 'follower' | 'following' | 'self'
 * @param {string} noteId - Note ID
 * @param {Date} postedAt - Post timestamp
 */
async function recordPostActivity(userId, authorNpub, authorType, noteId, postedAt) {
  try {
    // Calculate hour_gmt from posted_at
    const postDate = new Date(postedAt);
    const hourGMT = postDate.getUTCHours();
    
    await db.query(
      `INSERT INTO post_activity (user_id, author_npub, author_type, note_id, posted_at, hour_gmt)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [userId, authorNpub, authorType, noteId, postedAt, hourGMT]
    );
  } catch (error) {
    console.error('Error recording post activity:', error);
    throw error;
  }
}

/**
 * Aggregate post activity into hourly buckets
 * Called periodically (e.g., daily) to update network_activity table
 * @param {number} userId - User ID
 * @param {string} period - '24h' | '7d' | '30d' | '6m'
 */
async function aggregateHourlyActivity(userId, period = '30d') {
  const intervalMap = {
    '24h': '1 day',
    '7d': '7 days',
    '30d': '30 days',
    '6m': '6 months'
  };
  
  const interval = intervalMap[period] || '30 days';
  
  try {
    // Aggregate follower activity
    await db.query(`
      INSERT INTO network_activity (user_id, activity_type, hour_gmt, activity_count, window_date)
      SELECT 
        $1 as user_id,
        'follower_post' as activity_type,
        hour_gmt,
        COUNT(*) as activity_count,
        CURRENT_DATE as window_date
      FROM post_activity
      WHERE user_id = $1 
        AND author_type = 'follower'
        AND posted_at > NOW() - INTERVAL '${interval}'
      GROUP BY hour_gmt
      ON CONFLICT (user_id, activity_type, hour_gmt, window_date)
      DO UPDATE SET 
        activity_count = EXCLUDED.activity_count,
        created_at = NOW()
    `, [userId]);
    
    // Aggregate following activity
    await db.query(`
      INSERT INTO network_activity (user_id, activity_type, hour_gmt, activity_count, window_date)
      SELECT 
        $1 as user_id,
        'following_post' as activity_type,
        hour_gmt,
        COUNT(*) as activity_count,
        CURRENT_DATE as window_date
      FROM post_activity
      WHERE user_id = $1 
        AND author_type = 'following'
        AND posted_at > NOW() - INTERVAL '${interval}'
      GROUP BY hour_gmt
      ON CONFLICT (user_id, activity_type, hour_gmt, window_date)
      DO UPDATE SET 
        activity_count = EXCLUDED.activity_count,
        created_at = NOW()
    `, [userId]);
    
    // Aggregate engagement activity (from events table)
    await db.query(`
      INSERT INTO network_activity (user_id, activity_type, hour_gmt, activity_count, window_date)
      SELECT 
        $1 as user_id,
        'engagement' as activity_type,
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::INTEGER as hour_gmt,
        COUNT(*) as activity_count,
        CURRENT_DATE as window_date
      FROM events
      WHERE user_id = $1 
        AND created_at > NOW() - INTERVAL '${interval}'
      GROUP BY hour_gmt
      ON CONFLICT (user_id, activity_type, hour_gmt, window_date)
      DO UPDATE SET 
        activity_count = EXCLUDED.activity_count,
        created_at = NOW()
    `, [userId]);
    
  } catch (error) {
    console.error('Error aggregating hourly activity:', error);
    throw error;
  }
}

/**
 * Get network activity distribution
 * @param {number} userId - User ID
 * @param {string} type - 'followers' | 'following' | 'engagement' | 'all'
 * @param {string} period - '24h' | '7d' | '30d' | '6m'
 * @returns {Object} Activity distribution by hour
 */
async function getNetworkActivity(userId, type = 'all', period = '30d') {
  const intervalMap = {
    '24h': '1 day',
    '7d': '7 days',
    '30d': '30 days',
    '6m': '6 months'
  };
  
  const interval = intervalMap[period] || '30 days';
  
  const typeMap = {
    'followers': 'follower_post',
    'following': 'following_post',
    'engagement': 'engagement'
  };
  
  try {
    const result = {};
    const currentTimeGMT = new Date().toISOString();
    
    if (type === 'all') {
      // Get all activity types
      for (const [key, dbType] of Object.entries(typeMap)) {
        const data = await getActivityByType(userId, dbType, interval);
        result[key] = data;
      }
    } else {
      const dbType = typeMap[type];
      result[type] = await getActivityByType(userId, dbType, interval);
    }
    
    return {
      period,
      current_time_gmt: currentTimeGMT,
      ...result
    };
    
  } catch (error) {
    console.error('Error getting network activity:', error);
    throw error;
  }
}

/**
 * Helper: Get activity for a specific type
 */
async function getActivityByType(userId, activityType, interval) {
  const hourlyResult = await db.query(`
    SELECT 
      hour_gmt,
      SUM(activity_count) as activity_count
    FROM network_activity
    WHERE user_id = $1 
      AND activity_type = $2
      AND window_date > CURRENT_DATE - INTERVAL '${interval}'
    GROUP BY hour_gmt
    ORDER BY hour_gmt
  `, [userId, activityType]);
  
  // Fill in missing hours with 0
  const hourlyDistribution = Array.from({ length: 24 }, (_, hour) => {
    const found = hourlyResult.rows.find(r => r.hour_gmt === hour);
    return {
      hour_gmt: hour,
      activity_count: found ? parseInt(found.activity_count) : 0
    };
  });
  
  // Calculate zone of max participation
  const zone = calculateMaxParticipationZone(hourlyDistribution);
  
  // Find peak hours (top 3)
  const sorted = [...hourlyDistribution].sort((a, b) => b.activity_count - a.activity_count);
  const peakHours = sorted.slice(0, 3).map(h => h.hour_gmt);
  
  return {
    hourly_distribution: hourlyDistribution,
    peak_hours: peakHours,
    zone_of_max_participation: zone
  };
}

/**
 * Calculate zone of maximum participation
 * Finds consecutive hours with highest activity (minimum 3-hour window)
 */
function calculateMaxParticipationZone(hourlyDistribution) {
  const minWindowSize = 3;
  const maxWindowSize = 6;
  
  let bestZone = null;
  let maxActivity = 0;
  
  // Try different window sizes
  for (let windowSize = minWindowSize; windowSize <= maxWindowSize; windowSize++) {
    for (let start = 0; start < 24; start++) {
      let activity = 0;
      
      // Calculate activity in this window (handle wraparound)
      for (let i = 0; i < windowSize; i++) {
        const hour = (start + i) % 24;
        activity += hourlyDistribution[hour].activity_count;
      }
      
      if (activity > maxActivity) {
        maxActivity = activity;
        const endHour = (start + windowSize - 1) % 24;
        bestZone = {
          start_hour_gmt: start,
          end_hour_gmt: endHour,
          window_size: windowSize,
          total_activity: activity
        };
      }
    }
  }
  
  if (!bestZone) {
    return null;
  }
  
  // Calculate percentage of total activity
  const totalActivity = hourlyDistribution.reduce((sum, h) => sum + h.activity_count, 0);
  bestZone.percentage_of_total = totalActivity > 0 
    ? parseFloat(((maxActivity / totalActivity) * 100).toFixed(1))
    : 0;
  
  return bestZone;
}

/**
 * Get best posting times with recommendations
 * @param {number} userId - User ID
 * @param {string} period - '24h' | '7d' | '30d' | '6m'
 * @returns {Object} Recommendations and analysis
 */
async function getBestPostingTimes(userId, period = '30d') {
  try {
    // Get all activity data
    const activityData = await getNetworkActivity(userId, 'all', period);
    
    // Combine follower and engagement activity (weighted)
    const combinedActivity = Array.from({ length: 24 }, (_, hour) => {
      const followerActivity = activityData.followers.hourly_distribution[hour].activity_count;
      const engagementActivity = activityData.engagement.hourly_distribution[hour].activity_count;
      
      // Weight: 60% follower activity, 40% engagement history
      const score = (followerActivity * 0.6) + (engagementActivity * 0.4);
      
      return {
        hour_gmt: hour,
        score: Math.round(score),
        follower_activity: followerActivity,
        engagement_activity: engagementActivity
      };
    });
    
    // Sort by score and get top 5 recommendations
    const sorted = [...combinedActivity].sort((a, b) => b.score - a.score);
    const topHours = sorted.slice(0, 5);
    
    const recommendations = topHours.map((hourData, index) => {
      const { hour_gmt, score, follower_activity, engagement_activity } = hourData;
      
      // Generate reason
      let reason = '';
      if (follower_activity > engagement_activity) {
        reason = `Peak follower activity (${follower_activity} posts)`;
      } else if (engagement_activity > follower_activity) {
        reason = `High engagement history (${engagement_activity} interactions)`;
      } else {
        reason = `Balanced network activity`;
      }
      
      // Calculate expected reach
      const maxScore = sorted[0].score;
      const relativeScore = maxScore > 0 ? (score / maxScore) * 100 : 0;
      let expectedReach = 'low';
      if (relativeScore >= 80) expectedReach = 'high';
      else if (relativeScore >= 60) expectedReach = 'medium-high';
      else if (relativeScore >= 40) expectedReach = 'medium';
      
      return {
        time_gmt: `${hour_gmt.toString().padStart(2, '0')}:00`,
        hour_gmt,
        score: Math.round(relativeScore),
        reason,
        expected_reach: expectedReach,
        data: {
          follower_posts: follower_activity,
          engagement_count: engagement_activity
        }
      };
    });
    
    // Get zone of max participation from follower activity
    const zone = activityData.followers.zone_of_max_participation;
    
    // Calculate total data points for confidence
    const totalDataPoints = combinedActivity.reduce((sum, h) => 
      sum + h.follower_activity + h.engagement_activity, 0
    );
    
    let confidence = 'low';
    if (totalDataPoints >= 1000) confidence = 'high';
    else if (totalDataPoints >= 500) confidence = 'medium';
    
    return {
      recommendations,
      zone_of_max_participation: zone ? {
        start_hour_gmt: zone.start_hour_gmt,
        end_hour_gmt: zone.end_hour_gmt,
        description: `Your network is most active between ${zone.start_hour_gmt}:00 - ${zone.end_hour_gmt}:00 GMT`
      } : null,
      analysis: {
        total_data_points: totalDataPoints,
        period_analyzed: period,
        confidence
      }
    };
    
  } catch (error) {
    console.error('Error getting best posting times:', error);
    throw error;
  }
}

/**
 * Cache insights for faster retrieval
 * @param {number} userId - User ID
 * @param {string} insightType - Type of insight
 * @param {Object} data - Insight data
 * @param {string} period - Time period
 * @param {number} ttlHours - Cache TTL in hours (default: 24)
 */
async function cacheInsight(userId, insightType, data, period, ttlHours = 24) {
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  
  await db.query(`
    INSERT INTO insights (user_id, insight_type, data, period, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, insight_type, period)
    DO UPDATE SET
      data = EXCLUDED.data,
      calculated_at = NOW(),
      expires_at = EXCLUDED.expires_at
  `, [userId, insightType, JSON.stringify(data), period, expiresAt]);
}

/**
 * Get cached insight if available and not expired
 * @param {number} userId - User ID
 * @param {string} insightType - Type of insight
 * @param {string} period - Time period
 * @returns {Object|null} Cached insight or null
 */
async function getCachedInsight(userId, insightType, period) {
  const result = await db.query(`
    SELECT data, calculated_at
    FROM insights
    WHERE user_id = $1 
      AND insight_type = $2 
      AND period = $3
      AND (expires_at IS NULL OR expires_at > NOW())
  `, [userId, insightType, period]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return {
    ...result.rows[0].data,
    cached_at: result.rows[0].calculated_at
  };
}

module.exports = {
  recordPostActivity,
  aggregateHourlyActivity,
  getNetworkActivity,
  getBestPostingTimes,
  cacheInsight,
  getCachedInsight
};
