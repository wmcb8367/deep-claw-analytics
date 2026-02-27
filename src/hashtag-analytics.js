/**
 * Hashtag Analytics
 * Analyze hashtag usage and performance for Nostr accounts
 * Scans Nostr relays directly for real-time data
 */

const db = require('./db');

// WebSocket polyfill for Node.js
const WebSocket = require('ws');
if (!global.WebSocket) {
  global.WebSocket = WebSocket;
}

// Relays to query
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
  'wss://relay.snort.social',
];

/**
 * Query a relay for events
 */
async function queryRelay(relayUrl, filter, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const events = [];
    let resolved = false;
    
    const ws = new WebSocket(relayUrl);
    const subId = 'sub_' + Math.random().toString(36).slice(2);
    
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        resolve(events);
      }
    };
    
    const timeout = setTimeout(cleanup, timeoutMs);
    
    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          events.push(msg[2]);
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          clearTimeout(timeout);
          cleanup();
        }
      } catch (e) {}
    });
    
    ws.on('error', () => {
      clearTimeout(timeout);
      cleanup();
    });
    
    ws.on('close', () => {
      clearTimeout(timeout);
      cleanup();
    });
  });
}

/**
 * Convert npub to hex pubkey
 */
function npubToHex(npub) {
  if (!npub || !npub.startsWith('npub1')) return npub;
  
  const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = npub.slice(5);
  
  const values = [];
  for (const char of data) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid npub');
    values.push(idx);
  }
  
  let bits = 0;
  let value = 0;
  const result = [];
  
  for (const v of values.slice(0, -6)) {
    value = (value << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((value >> bits) & 0xff);
    }
  }
  
  return result.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch user's posts from Nostr relays
 */
async function fetchUserPosts(pubkeyHex, days = 90) {
  const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  const allPosts = [];
  
  console.log(`[Hashtag] Fetching posts for ${pubkeyHex.slice(0, 8)}...`);
  
  for (const relay of RELAYS.slice(0, 3)) {
    try {
      const events = await queryRelay(relay, {
        kinds: [1],
        authors: [pubkeyHex],
        since: since,
        limit: 200
      }, 8000);
      
      for (const event of events) {
        if (!allPosts.find(p => p.id === event.id)) {
          allPosts.push(event);
        }
      }
      
      if (allPosts.length > 0) {
        console.log(`[Hashtag] Found ${allPosts.length} posts from ${relay}`);
        break; // Got posts, no need to try more relays
      }
    } catch (e) {
      console.log(`[Hashtag] ${relay} failed:`, e.message);
    }
  }
  
  return allPosts;
}

/**
 * Fetch trending posts from Nostr for hashtag analysis
 * Strategy: Query posts with popular hashtags to find what's trending
 */
async function fetchTrendingPosts(hours = 24) {
  const since = Math.floor(Date.now() / 1000) - (hours * 60 * 60);
  const allPosts = [];
  const seen = new Set();
  
  console.log(`[Hashtag] Fetching trending posts (last ${hours}h)...`);
  
  // Popular hashtags to seed our search
  const seedHashtags = [
    'bitcoin', 'nostr', 'grownostr', 'plebchain', 'lightning',
    'zap', 'btc', 'coffeechain', 'asknostr', 'introductions',
    'memes', 'art', 'music', 'tech', 'dev', 'ai'
  ];
  
  // Relays to query
  const relays = [
    'wss://relay.nostr.band',
    'wss://relay.damus.io',
    'wss://nos.lol'
  ];
  
  // Query each relay for recent posts
  for (const relay of relays) {
    try {
      // Get recent posts (limit query to be reasonable)
      const events = await queryRelay(relay, {
        kinds: [1],
        since: since,
        limit: 200
      }, 12000);
      
      for (const event of events) {
        if (!seen.has(event.id) && event.content) {
          seen.add(event.id);
          allPosts.push(event);
        }
      }
      
      console.log(`[Hashtag] Got ${events.length} posts from ${relay}`);
      
      if (allPosts.length >= 300) break; // Got enough
    } catch (e) {
      console.log(`[Hashtag] ${relay} failed:`, e.message);
    }
  }
  
  // If we got posts, filter to only those with hashtags
  const postsWithHashtags = allPosts.filter(post => {
    const content = post.content || '';
    return content.includes('#') && /#\w+/.test(content);
  });
  
  console.log(`[Hashtag] Found ${allPosts.length} total posts, ${postsWithHashtags.length} with hashtags`);
  
  // Return posts with hashtags, or all posts if not enough
  return postsWithHashtags.length >= 50 ? postsWithHashtags : allPosts;
}

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
 * Scans Nostr relays directly for real-time data
 */
async function getPersonalHashtags(req, res) {
  try {
    const npub = req.query.npub || req.user?.npub;
    const days = parseInt(req.query.days) || 90;
    
    if (!npub) {
      return res.status(400).json({
        error: 'Missing npub',
        message: 'Provide npub query parameter'
      });
    }
    
    const pubkeyHex = npubToHex(npub);
    
    // Fetch user's posts from Nostr relays
    console.log(`[Hashtag] Scanning posts for ${npub.slice(0, 20)}...`);
    const posts = await fetchUserPosts(pubkeyHex, days);
    
    if (posts.length === 0) {
      return res.json({
        overview: {
          totalPosts: 0,
          postsWithHashtags: 0,
          postsWithoutHashtags: 0,
          hashtagUsageRate: 0,
          impact: 'neutral',
          impactPercentage: 0
        },
        hashtagsUsed: [],
        topTopics: [],
        suggestions: [],
        message: 'No posts found. Try posting some content first!'
      });
    }
    
    // Analyze hashtags and topics
    const hashtagStats = {};
    const topicCounts = {};
    let postsWithHashtags = 0;
    let postsWithoutHashtags = 0;
    
    // We don't have engagement data from relays, so we'll track usage only
    // In the future, we could query for reactions to each post
    
    for (const post of posts) {
      const content = post.content || '';
      const hashtags = extractHashtags(content);
      const topics = extractTopics(content);
      
      // Track topics
      for (const topic of topics) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
      
      if (hashtags.length > 0) {
        postsWithHashtags++;
        
        // Track each hashtag's usage
        for (const tag of hashtags) {
          if (!hashtagStats[tag]) {
            hashtagStats[tag] = {
              count: 0,
              posts: [],
              firstUsed: post.created_at,
              lastUsed: post.created_at
            };
          }
          
          hashtagStats[tag].count++;
          hashtagStats[tag].posts.push({
            noteId: post.id,
            content: content.slice(0, 100),
            postedAt: new Date(post.created_at * 1000).toISOString()
          });
          
          // Track first/last used
          if (post.created_at < hashtagStats[tag].firstUsed) {
            hashtagStats[tag].firstUsed = post.created_at;
          }
          if (post.created_at > hashtagStats[tag].lastUsed) {
            hashtagStats[tag].lastUsed = post.created_at;
          }
        }
      } else {
        postsWithoutHashtags++;
      }
    }
    
    // Format hashtag stats
    const hashtagsUsed = Object.entries(hashtagStats)
      .map(([tag, stats]) => ({
        hashtag: tag,
        timesUsed: stats.count,
        firstUsed: new Date(stats.firstUsed * 1000).toISOString(),
        lastUsed: new Date(stats.lastUsed * 1000).toISOString(),
        recentPosts: stats.posts.slice(0, 3) // Last 3 posts with this hashtag
      }))
      .sort((a, b) => b.timesUsed - a.timesUsed);
    
    // Get top topics
    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count }));
    
    // Generate suggestions based on topics
    const suggestions = await generateHashtagSuggestions(topTopics, hashtagsUsed);
    
    const hashtagUsageRate = posts.length > 0 
      ? postsWithHashtags / posts.length 
      : 0;
    
    res.json({
      overview: {
        totalPosts: posts.length,
        postsWithHashtags,
        postsWithoutHashtags,
        hashtagUsageRate,
        uniqueHashtagsUsed: hashtagsUsed.length,
        // Without engagement data, we can't calculate impact
        // But we can give recommendations based on usage
        impact: hashtagUsageRate > 0.5 ? 'active' : hashtagUsageRate > 0.2 ? 'moderate' : 'low',
        recommendation: hashtagUsageRate < 0.3 
          ? 'Try using more hashtags to increase discoverability'
          : hashtagUsageRate > 0.8
          ? 'Good hashtag usage! Consider varying your hashtags'
          : 'Balanced hashtag usage'
      },
      hashtagsUsed: hashtagsUsed.slice(0, 20),
      topTopics,
      suggestions,
      scannedPeriod: `${days} days`,
      scannedAt: new Date().toISOString()
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
  // Comprehensive topic to hashtag mapping
  const topicHashtagMap = {
    // Crypto & Bitcoin
    'bitcoin': ['bitcoin', 'btc', 'hodl', 'satoshi'],
    'crypto': ['crypto', 'cryptocurrency', 'web3'],
    'lightning': ['lightning', 'ln', 'zaps', 'lnurl'],
    'sats': ['sats', 'stackingsats', 'satoshi'],
    'money': ['bitcoin', 'soundmoney', 'inflation'],
    
    // Nostr & Social
    'nostr': ['nostr', 'grownostr', 'nostrich'],
    'social': ['plebchain', 'nostrcommunity'],
    'follow': ['followfriday', 'introductions'],
    
    // Tech & Dev
    'building': ['buidl', 'building', 'opensource'],
    'code': ['dev', 'programming', 'code'],
    'tech': ['tech', 'technology', 'innovation'],
    'rust': ['rustlang', 'rust', 'programming'],
    'python': ['python', 'programming'],
    
    // Content types
    'meme': ['meme', 'memes', 'humor', 'funny'],
    'art': ['art', 'artstr', 'artist', 'creative'],
    'music': ['music', 'tunestr', 'musician'],
    'photo': ['photography', 'photostr', 'photo'],
    'food': ['foodstr', 'cooking', 'food'],
    'travel': ['travel', 'travelstr', 'adventure'],
    
    // Community
    'coffee': ['coffeechain', 'coffee', 'gm'],
    'morning': ['gm', 'goodmorning', 'coffeechain'],
    'freedom': ['freedom', 'liberty', 'sovereignty'],
    'news': ['news', 'current', 'breaking'],
    
    // AI
    'ai': ['ai', 'artificialintelligence', 'machinelearning'],
    'agent': ['aiagent', 'autonomousai'],
    'lobster': ['lobster', 'spacelobster'] // For Deep Claw :)
  };
  
  const usedHashtags = new Set(hashtagsUsed.map(h => h.hashtag));
  const suggestions = [];
  const suggestedSet = new Set();
  
  // First, suggest based on content topics
  for (const { topic } of topTopics) {
    // Check direct topic match
    if (topicHashtagMap[topic]) {
      for (const tag of topicHashtagMap[topic]) {
        if (!usedHashtags.has(tag) && !suggestedSet.has(tag)) {
          suggestedSet.add(tag);
          suggestions.push({
            hashtag: tag,
            reason: `Matches your topic: "${topic}"`,
            confidence: 'high',
            category: 'topic_match'
          });
        }
      }
    }
    
    // Check partial matches
    for (const [key, tags] of Object.entries(topicHashtagMap)) {
      if (topic.includes(key) || key.includes(topic)) {
        for (const tag of tags) {
          if (!usedHashtags.has(tag) && !suggestedSet.has(tag)) {
            suggestedSet.add(tag);
            suggestions.push({
              hashtag: tag,
              reason: `Related to "${topic}"`,
              confidence: 'medium',
              category: 'related'
            });
          }
        }
      }
    }
  }
  
  // Essential Nostr hashtags for growth
  const essentialTags = [
    { tag: 'grownostr', reason: '🚀 Essential for growth - active community', confidence: 'high' },
    { tag: 'plebchain', reason: '⚡ Engaged Bitcoin/Nostr community', confidence: 'high' },
    { tag: 'introductions', reason: '👋 Great for new followers', confidence: 'medium' },
    { tag: 'asknostr', reason: '❓ For questions - high engagement', confidence: 'medium' },
    { tag: 'zapathon', reason: '⚡ For zap-worthy content', confidence: 'medium' },
    { tag: 'coffeechain', reason: '☕ Morning posts, social vibes', confidence: 'medium' },
    { tag: 'nostr', reason: '📢 Core Nostr hashtag', confidence: 'high' }
  ];
  
  for (const { tag, reason, confidence } of essentialTags) {
    if (!usedHashtags.has(tag) && !suggestedSet.has(tag) && suggestions.length < 15) {
      suggestedSet.add(tag);
      suggestions.push({
        hashtag: tag,
        reason,
        confidence,
        category: 'essential'
      });
    }
  }
  
  // Sort by confidence and limit
  const confidenceOrder = { high: 3, medium: 2, low: 1 };
  suggestions.sort((a, b) => confidenceOrder[b.confidence] - confidenceOrder[a.confidence]);
  
  return suggestions.slice(0, 12);
}

/**
 * GET /hashtags/trending
 * Get trending hashtags on Nostr
 * Scans relays directly for real-time trending data
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
    
    // Fetch posts from Nostr relays
    console.log(`[Hashtag] Fetching trending posts (${period})...`);
    const posts = await fetchTrendingPosts(hours);
    
    if (posts.length === 0) {
      return res.json({
        period,
        trending: [],
        totalHashtags: 0,
        message: 'Could not fetch trending posts from relays'
      });
    }
    
    // Extract and count hashtags
    const hashtagCounts = {};
    const hashtagPosts = {};
    
    for (const post of posts) {
      const content = post.content || '';
      const hashtags = extractHashtags(content);
      
      for (const tag of hashtags) {
        if (!hashtagCounts[tag]) {
          hashtagCounts[tag] = 0;
          hashtagPosts[tag] = [];
        }
        hashtagCounts[tag]++;
        hashtagPosts[tag].push({
          id: post.id,
          created_at: post.created_at,
          content: content.slice(0, 100)
        });
      }
    }
    
    // Sort by count and format
    const trending = Object.entries(hashtagCounts)
      .filter(([tag, count]) => count >= 2) // At least 2 uses
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag, count], index) => {
        const tagPosts = hashtagPosts[tag] || [];
        const recentPosts = tagPosts.filter(p => 
          p.created_at > (Date.now() / 1000) - (24 * 60 * 60)
        ).length;
        
        return {
          rank: index + 1,
          hashtag: tag,
          postCount: count,
          recentPosts,
          samplePosts: tagPosts.slice(0, 3).map(p => ({
            content: p.content,
            postedAt: new Date(p.created_at * 1000).toISOString()
          })),
          trend: recentPosts > count * 0.5 ? 'rising' : 'stable'
        };
      });
    
    // Categorize trending hashtags
    const categories = categorizeTrendingHashtags(trending);
    
    // Add strategy insights
    const strategy = generateHashtagStrategy(trending, Object.keys(hashtagCounts).length);
    
    res.json({
      period,
      totalPostsScanned: posts.length,
      totalUniqueHashtags: Object.keys(hashtagCounts).length,
      trending,
      categories,
      strategy,
      scannedAt: new Date().toISOString()
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
 * Generate hashtag strategy recommendations
 * Addresses the question: how to balance popular vs niche hashtags on Nostr
 */
function generateHashtagStrategy(trending, totalUniqueHashtags) {
  // Categorize hashtags by competition level
  const highCompetition = trending.filter(t => t.postCount >= 20);
  const mediumCompetition = trending.filter(t => t.postCount >= 5 && t.postCount < 20);
  const lowCompetition = trending.filter(t => t.postCount < 5);
  
  // Nostr-specific insights
  const insights = [
    {
      title: "Nostr is Different",
      insight: "Unlike Twitter/Instagram, Nostr hashtags don't get 'drowned out' by volume. There's no algorithm suppressing you - everyone who follows a hashtag sees your post.",
      recommendation: "Use popular hashtags freely - they help discoverability without penalty."
    },
    {
      title: "Quality Over Quantity",  
      insight: "Nostr users are savvy and engaged. Spammy hashtag stuffing stands out negatively.",
      recommendation: "Use 2-4 relevant hashtags per post. More than 5 looks desperate."
    },
    {
      title: "Community Hashtags Matter",
      insight: "Tags like #grownostr, #plebchain, #coffeechain are community signals, not just discovery tools.",
      recommendation: "Use community hashtags to show you're part of the tribe, not just broadcasting."
    }
  ];
  
  // Recommended mix based on current data
  const recommendedMix = {
    high: highCompetition.slice(0, 2).map(t => t.hashtag),
    medium: mediumCompetition.slice(0, 3).map(t => t.hashtag),
    niche: lowCompetition.slice(0, 2).map(t => t.hashtag),
    explanation: "Mix 1 popular tag (reach) + 1-2 community tags (belonging) + 1 niche tag (targeted audience)"
  };
  
  // Competition breakdown
  const competitionBreakdown = {
    high: {
      count: highCompetition.length,
      tags: highCompetition.slice(0, 5).map(t => t.hashtag),
      advice: "Good for reach. Your post won't get buried - Nostr feeds are chronological."
    },
    medium: {
      count: mediumCompetition.length,
      tags: mediumCompetition.slice(0, 5).map(t => t.hashtag),
      advice: "Sweet spot. Active enough to be seen, focused enough to find your people."
    },
    low: {
      count: lowCompetition.length,
      tags: lowCompetition.slice(0, 5).map(t => t.hashtag),
      advice: "Niche territory. Great for targeting specific interests, but less discovery."
    }
  };
  
  return {
    nostrAdvantage: "On Nostr, popular hashtags help you WITHOUT the drowning effect. No algorithm is hiding your posts.",
    insights,
    recommendedMix,
    competitionBreakdown,
    bottomLine: "Use 2-4 hashtags: 1 popular + 1-2 community + 1 topic-specific. Don't overthink it - Nostr rewards authenticity over SEO gaming."
  };
}

/**
 * Categorize trending hashtags into topics
 */
function categorizeTrendingHashtags(trending) {
  const categories = {
    crypto: [],
    nostr: [],
    tech: [],
    community: [],
    other: []
  };
  
  const categoryPatterns = {
    crypto: ['bitcoin', 'btc', 'crypto', 'lightning', 'ln', 'sats', 'zaps', 'hodl', 'defi', 'eth'],
    nostr: ['nostr', 'grownostr', 'plebchain', 'zapathon', 'nostrich', 'damus', 'primal', 'snort'],
    tech: ['dev', 'code', 'programming', 'rust', 'python', 'ai', 'tech', 'build', 'buidl'],
    community: ['coffeechain', 'foodstr', 'artstr', 'photostr', 'asknostr', 'introduction', 'gm']
  };
  
  for (const tag of trending) {
    let categorized = false;
    
    for (const [category, patterns] of Object.entries(categoryPatterns)) {
      if (patterns.some(p => tag.hashtag.includes(p))) {
        categories[category].push(tag.hashtag);
        categorized = true;
        break;
      }
    }
    
    if (!categorized) {
      categories.other.push(tag.hashtag);
    }
  }
  
  return categories;
}

/**
 * GET /hashtags/recommendations
 * Get personalized hashtag recommendations
 * Combines personal analysis with trending data
 */
async function getHashtagRecommendations(req, res) {
  try {
    const npub = req.query.npub || req.user?.npub;
    
    if (!npub) {
      return res.status(400).json({
        error: 'Missing npub',
        message: 'Provide npub query parameter'
      });
    }
    
    const pubkeyHex = npubToHex(npub);
    
    // Fetch user's posts
    console.log(`[Hashtag] Getting recommendations for ${npub.slice(0, 20)}...`);
    const posts = await fetchUserPosts(pubkeyHex, 30);
    
    // Extract topics and used hashtags
    const allTopics = [];
    const usedHashtags = new Set();
    
    for (const post of posts) {
      const content = post.content || '';
      const topics = extractTopics(content);
      const hashtags = extractHashtags(content);
      
      allTopics.push(...topics);
      hashtags.forEach(tag => usedHashtags.add(tag));
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
    
    // Fetch trending for comparison
    const trendingPosts = await fetchTrendingPosts(24);
    const trendingHashtags = {};
    
    for (const post of trendingPosts) {
      const hashtags = extractHashtags(post.content || '');
      for (const tag of hashtags) {
        trendingHashtags[tag] = (trendingHashtags[tag] || 0) + 1;
      }
    }
    
    const recommendations = [];
    const suggestedSet = new Set();
    
    // Topic-based recommendations
    const topicHashtagMap = {
      'bitcoin': ['bitcoin', 'btc', 'hodl'],
      'nostr': ['nostr', 'grownostr', 'plebchain'],
      'lightning': ['lightning', 'zaps', 'ln'],
      'tech': ['tech', 'dev', 'buidl'],
      'ai': ['ai', 'artificialintelligence'],
      'freedom': ['freedom', 'liberty'],
      'meme': ['meme', 'memes', 'humor']
    };
    
    for (const { topic } of topTopics) {
      if (topicHashtagMap[topic]) {
        for (const tag of topicHashtagMap[topic]) {
          if (!usedHashtags.has(tag) && !suggestedSet.has(tag)) {
            suggestedSet.add(tag);
            recommendations.push({
              hashtag: tag,
              reason: `Matches your topic: "${topic}"`,
              type: 'topic_based',
              priority: 'high'
            });
          }
        }
      }
    }
    
    // Trending hashtags user hasn't tried
    const sortedTrending = Object.entries(trendingHashtags)
      .filter(([tag]) => !usedHashtags.has(tag) && !suggestedSet.has(tag))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    for (const [tag, count] of sortedTrending) {
      suggestedSet.add(tag);
      recommendations.push({
        hashtag: tag,
        reason: `Trending now (${count} recent uses)`,
        type: 'trending',
        priority: 'medium',
        trendingCount: count
      });
    }
    
    // Essential Nostr hashtags
    const essentials = ['grownostr', 'plebchain', 'nostr', 'zapathon'];
    for (const tag of essentials) {
      if (!usedHashtags.has(tag) && !suggestedSet.has(tag)) {
        suggestedSet.add(tag);
        recommendations.push({
          hashtag: tag,
          reason: 'Essential Nostr community hashtag',
          type: 'essential',
          priority: 'high'
        });
      }
    }
    
    // Sort by priority
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    recommendations.sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);
    
    res.json({
      recommendations: recommendations.slice(0, 15),
      yourTopics: topTopics,
      hashtagsYouUse: Array.from(usedHashtags).slice(0, 10),
      postsAnalyzed: posts.length,
      scannedAt: new Date().toISOString()
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
