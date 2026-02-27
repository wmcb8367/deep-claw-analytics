/**
 * Hashtag Analytics
 * Analyze hashtag usage and performance for Nostr accounts
 */

const db = require('./db');

/**
 * Extract hashtags from text
 * @param {string} text - Post content
 * @returns {string[]} - Array of hashtags (without #)
 */
function extractHashtags(text) {
  if (!text) return [];
  
  // Match #word pattern, exclude URLs
  const hashtagRegex = /#(\w+)/g;
  const hashtags = [];
  let match;
  
  while ((match = hashtagRegex.exec(text)) !== null) {
    hashtags.push(match[1].toLowerCase());
  }
  
  return [...new Set(hashtags)]; // Remove duplicates
}

/**
 * Extract topics/keywords from text (simple keyword extraction)
 * @param {string} text - Post content
 * @returns {string[]} - Array of likely topics
 */
function extractTopics(text) {
  if (!text) return [];
  
  // Common stop words to ignore
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'should', 'could', 'may', 'might', 'can', 'this', 'that',
    'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my',
    'your', 'his', 'her', 'its', 'our', 'their', 'me', 'him', 'them'
  ]);
  
  // Remove URLs and hashtags
  let cleanText = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#\w+/g, '')
    .toLowerCase();
  
  // Extract words
  const words = cleanText.match(/\b[a-z]{4,}\b/g) || [];
  
  // Filter and count
  const wordCounts = {};
  for (const word of words) {
    if (!stopWords.has(word)) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
  }
  
  // Get top 5 most frequent words
  const topics = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
  
  return topics;
}

/**
 * GET /hashtags/personal
 * Analyze user's hashtag usage and performance
 */
async function getPersonalHashtags(req, res) {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    
    // Get user's recent posts with hashtags
    const postsQuery = `
      SELECT 
        p.note_id,
        p.content,
        p.posted_at,
        p.reactions,
        p.replies,
        p.reposts,
        p.impressions
      FROM posts p
      WHERE p.user_id = $1
        AND p.posted_at >= NOW() - INTERVAL '90 days'
      ORDER BY p.posted_at DESC
      LIMIT $2
    `;
    
    const postsResult = await db.query(postsQuery, [userId, limit]);
    
    // Analyze hashtags and topics
    const hashtagStats = {};
    const topicCounts = {};
    let postsWithHashtags = 0;
    let postsWithoutHashtags = 0;
    let totalEngagementWithHashtags = 0;
    let totalEngagementWithoutHashtags = 0;
    let impressionsWithHashtags = 0;
    let impressionsWithoutHashtags = 0;
    
    for (const post of postsResult.rows) {
      const hashtags = extractHashtags(post.content);
      const topics = extractTopics(post.content);
      const engagement = (post.reactions || 0) + (post.replies || 0) + (post.reposts || 0);
      const impressions = post.impressions || 0;
      
      // Track topics
      for (const topic of topics) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
      
      if (hashtags.length > 0) {
        postsWithHashtags++;
        totalEngagementWithHashtags += engagement;
        impressionsWithHashtags += impressions;
        
        // Track each hashtag's performance
        for (const tag of hashtags) {
          if (!hashtagStats[tag]) {
            hashtagStats[tag] = {
              count: 0,
              totalEngagement: 0,
              totalImpressions: 0,
              posts: []
            };
          }
          
          hashtagStats[tag].count++;
          hashtagStats[tag].totalEngagement += engagement;
          hashtagStats[tag].totalImpressions += impressions;
          hashtagStats[tag].posts.push({
            noteId: post.note_id,
            engagement,
            impressions,
            postedAt: post.posted_at
          });
        }
      } else {
        postsWithoutHashtags++;
        totalEngagementWithoutHashtags += engagement;
        impressionsWithoutHashtags += impressions;
      }
    }
    
    // Calculate averages
    const avgEngagementWithHashtags = postsWithHashtags > 0 
      ? totalEngagementWithHashtags / postsWithHashtags 
      : 0;
    const avgEngagementWithoutHashtags = postsWithoutHashtags > 0
      ? totalEngagementWithoutHashtags / postsWithoutHashtags
      : 0;
    const avgEngagementRateWithHashtags = impressionsWithHashtags > 0
      ? totalEngagementWithHashtags / impressionsWithHashtags
      : 0;
    const avgEngagementRateWithoutHashtags = impressionsWithoutHashtags > 0
      ? totalEngagementWithoutHashtags / impressionsWithoutHashtags
      : 0;
    
    // Format hashtag stats
    const hashtagsUsed = Object.entries(hashtagStats).map(([tag, stats]) => ({
      hashtag: tag,
      timesUsed: stats.count,
      avgEngagement: stats.totalEngagement / stats.count,
      avgEngagementRate: stats.totalImpressions > 0 
        ? stats.totalEngagement / stats.totalImpressions
        : 0,
      totalImpressions: stats.totalImpressions,
      lastUsed: stats.posts[0].postedAt,
      performance: stats.totalEngagement / stats.count > avgEngagementWithHashtags 
        ? 'above_average' 
        : 'below_average'
    })).sort((a, b) => b.avgEngagement - a.avgEngagement);
    
    // Get top topics
    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count }));
    
    // Generate suggestions based on topics
    const suggestions = await generateHashtagSuggestions(topTopics, hashtagsUsed);
    
    res.json({
      overview: {
        totalPosts: postsResult.rows.length,
        postsWithHashtags,
        postsWithoutHashtags,
        hashtagUsageRate: postsResult.rows.length > 0 
          ? postsWithHashtags / postsResult.rows.length 
          : 0,
        avgEngagementWithHashtags,
        avgEngagementWithoutHashtags,
        avgEngagementRateWithHashtags,
        avgEngagementRateWithoutHashtags,
        impact: avgEngagementWithHashtags > avgEngagementWithoutHashtags 
          ? 'positive' 
          : avgEngagementWithHashtags < avgEngagementWithoutHashtags 
          ? 'negative' 
          : 'neutral',
        impactPercentage: avgEngagementWithoutHashtags > 0
          ? Math.round(((avgEngagementWithHashtags - avgEngagementWithoutHashtags) / avgEngagementWithoutHashtags) * 100)
          : 0
      },
      hashtagsUsed: hashtagsUsed.slice(0, 20), // Top 20
      topTopics,
      suggestions
    });
    
  } catch (error) {
    console.error('Get personal hashtags error:', error);
    res.status(500).json({
      error: 'Failed to get personal hashtags',
      message: error.message
    });
  }
}

/**
 * Generate hashtag suggestions based on user's topics
 */
async function generateHashtagSuggestions(topTopics, hashtagsUsed) {
  // Map common topics to relevant hashtags
  const topicHashtagMap = {
    'bitcoin': ['bitcoin', 'btc', 'crypto'],
    'nostr': ['nostr', 'grownostr', 'plebchain'],
    'lightning': ['lightning', 'ln', 'zaps'],
    'freedom': ['freedom', 'liberty', 'sovereignty'],
    'building': ['buidl', 'building', 'dev'],
    'tech': ['tech', 'technology', 'innovation'],
    'news': ['news', 'breaking', 'current'],
    'meme': ['meme', 'memes', 'funny'],
    'art': ['art', 'artist', 'artstr'],
    'music': ['music', 'tunestr', 'musician'],
    'food': ['foodstr', 'cooking', 'food'],
    'photography': ['photography', 'photostr', 'photo']
  };
  
  const usedHashtags = new Set(hashtagsUsed.map(h => h.hashtag));
  const suggestions = [];
  
  for (const { topic } of topTopics) {
    // Direct mapping
    if (topicHashtagMap[topic]) {
      for (const tag of topicHashtagMap[topic]) {
        if (!usedHashtags.has(tag)) {
          suggestions.push({
            hashtag: tag,
            reason: `Related to your topic: ${topic}`,
            confidence: 'high'
          });
        }
      }
    }
    
    // Topic itself as hashtag
    if (!usedHashtags.has(topic) && topic.length >= 4) {
      suggestions.push({
        hashtag: topic,
        reason: `Direct topic from your content`,
        confidence: 'medium'
      });
    }
  }
  
  // Add common Nostr hashtags if not used
  const commonNostrTags = [
    { tag: 'grownostr', reason: 'Popular community hashtag' },
    { tag: 'plebchain', reason: 'Engaged Nostr community' },
    { tag: 'coffeechain', reason: 'Popular social hashtag' },
    { tag: 'asknostr', reason: 'For questions and discussions' }
  ];
  
  for (const { tag, reason } of commonNostrTags) {
    if (!usedHashtags.has(tag) && suggestions.length < 10) {
      suggestions.push({
        hashtag: tag,
        reason,
        confidence: 'medium'
      });
    }
  }
  
  return suggestions.slice(0, 10);
}

/**
 * GET /hashtags/trending
 * Get trending hashtags on Nostr
 */
async function getTrendingHashtags(req, res) {
  try {
    const period = req.query.period || '24h';
    const limit = parseInt(req.query.limit) || 20;
    
    // Convert period to hours
    const periodHours = {
      '24h': 24,
      '7d': 168,
      '30d': 720
    };
    const hours = periodHours[period] || 24;
    
    // Query global hashtag usage from posts
    // This assumes we're tracking global posts or have a global_posts table
    const query = `
      WITH hashtag_usage AS (
        SELECT 
          unnest(regexp_matches(content, '#(\\w+)', 'g')) as hashtag,
          note_id,
          posted_at,
          (reactions + replies + reposts) as engagement,
          impressions
        FROM posts
        WHERE posted_at >= NOW() - INTERVAL '${hours} hours'
      )
      SELECT 
        lower(hashtag) as hashtag,
        COUNT(DISTINCT note_id) as post_count,
        COUNT(DISTINCT note_id) FILTER (WHERE posted_at >= NOW() - INTERVAL '24 hours') as recent_posts,
        SUM(engagement) as total_engagement,
        AVG(engagement) as avg_engagement,
        SUM(impressions) as total_impressions,
        MAX(posted_at) as last_used
      FROM hashtag_usage
      GROUP BY lower(hashtag)
      HAVING COUNT(DISTINCT note_id) >= 3
      ORDER BY post_count DESC, total_engagement DESC
      LIMIT $1
    `;
    
    const result = await db.query(query, [limit]);
    
    const trending = result.rows.map(row => ({
      hashtag: row.hashtag,
      postCount: parseInt(row.post_count) || 0,
      recentPosts: parseInt(row.recent_posts) || 0,
      totalEngagement: parseInt(row.total_engagement) || 0,
      avgEngagement: parseFloat(row.avg_engagement) || 0,
      totalImpressions: parseInt(row.total_impressions) || 0,
      engagementRate: row.total_impressions > 0 
        ? parseFloat(row.total_engagement) / parseFloat(row.total_impressions)
        : 0,
      lastUsed: row.last_used,
      trend: parseInt(row.recent_posts) > parseInt(row.post_count) / (hours / 24) 
        ? 'rising' 
        : 'stable'
    }));
    
    res.json({
      period,
      trending,
      totalHashtags: result.rows.length
    });
    
  } catch (error) {
    console.error('Get trending hashtags error:', error);
    res.status(500).json({
      error: 'Failed to get trending hashtags',
      message: error.message
    });
  }
}

/**
 * GET /hashtags/recommendations
 * Get personalized hashtag recommendations
 */
async function getHashtagRecommendations(req, res) {
  try {
    const userId = req.user.id;
    
    // Get user's personal hashtag data
    const personalQuery = `
      SELECT content
      FROM posts
      WHERE user_id = $1
        AND posted_at >= NOW() - INTERVAL '30 days'
      ORDER BY posted_at DESC
      LIMIT 50
    `;
    
    const personalResult = await db.query(personalQuery, [userId]);
    
    // Extract topics from recent posts
    const allTopics = [];
    for (const post of personalResult.rows) {
      const topics = extractTopics(post.content);
      allTopics.push(...topics);
    }
    
    // Count topic frequency
    const topicCounts = {};
    for (const topic of allTopics) {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
    
    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count }));
    
    // Get hashtags user has used
    const usedHashtags = new Set();
    for (const post of personalResult.rows) {
      const hashtags = extractHashtags(post.content);
      hashtags.forEach(tag => usedHashtags.add(tag));
    }
    
    // Get trending hashtags
    const trendingQuery = `
      WITH hashtag_usage AS (
        SELECT 
          unnest(regexp_matches(content, '#(\\w+)', 'g')) as hashtag,
          (reactions + replies + reposts) as engagement
        FROM posts
        WHERE posted_at >= NOW() - INTERVAL '7 days'
      )
      SELECT 
        lower(hashtag) as hashtag,
        COUNT(*) as usage_count,
        AVG(engagement) as avg_engagement
      FROM hashtag_usage
      GROUP BY lower(hashtag)
      HAVING COUNT(*) >= 5
      ORDER BY avg_engagement DESC
      LIMIT 20
    `;
    
    const trendingResult = await db.query(trendingQuery);
    
    const recommendations = [];
    
    // Add topic-based recommendations
    for (const { topic } of topTopics) {
      if (!usedHashtags.has(topic)) {
        recommendations.push({
          hashtag: topic,
          reason: `Matches your content topic`,
          type: 'topic_based',
          priority: 'high'
        });
      }
    }
    
    // Add trending hashtags user hasn't used
    for (const row of trendingResult.rows) {
      const tag = row.hashtag;
      if (!usedHashtags.has(tag)) {
        recommendations.push({
          hashtag: tag,
          reason: `Trending with ${Math.round(row.avg_engagement)} avg engagement`,
          type: 'trending',
          priority: 'medium',
          avgEngagement: parseFloat(row.avg_engagement) || 0
        });
      }
    }
    
    // Deduplicate and limit
    const uniqueRecs = [];
    const seen = new Set();
    for (const rec of recommendations) {
      if (!seen.has(rec.hashtag)) {
        seen.add(rec.hashtag);
        uniqueRecs.push(rec);
      }
    }
    
    res.json({
      recommendations: uniqueRecs.slice(0, 15)
    });
    
  } catch (error) {
    console.error('Get hashtag recommendations error:', error);
    res.status(500).json({
      error: 'Failed to get hashtag recommendations',
      message: error.message
    });
  }
}

module.exports = {
  extractHashtags,
  extractTopics,
  getPersonalHashtags,
  getTrendingHashtags,
  getHashtagRecommendations
};
