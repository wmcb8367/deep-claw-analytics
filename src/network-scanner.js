/**
 * Network Scanner
 * Fetches historical activity from a user's network (following) from Nostr relays
 * to bootstrap timing analytics data
 */

// WebSocket polyfill for Node.js environment
const WebSocket = require('ws');
global.WebSocket = WebSocket;

const { SimplePool, nip19 } = require('nostr-tools');
const db = require('./db');

// Default relays to query
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://relay.snort.social',
  'wss://purplepag.es',
];

/**
 * Get a user's following list from Nostr
 * @param {string} pubkey - User's hex pubkey
 * @param {string[]} relays - Relays to query
 * @returns {Promise<string[]>} - List of followed pubkeys
 */
async function getFollowingList(pubkey, relays = DEFAULT_RELAYS) {
  const pool = new SimplePool();
  
  try {
    // Kind 3 is the contact list
    const contactEvent = await pool.get(relays, {
      kinds: [3],
      authors: [pubkey],
    });
    
    if (!contactEvent) {
      return [];
    }
    
    // Extract pubkeys from p tags
    const following = contactEvent.tags
      .filter(tag => tag[0] === 'p')
      .map(tag => tag[1]);
    
    return following;
  } finally {
    pool.close(relays);
  }
}

/**
 * Fetch recent posts from a list of pubkeys
 * @param {string[]} pubkeys - Pubkeys to fetch posts from
 * @param {number} since - Unix timestamp to fetch posts since
 * @param {string[]} relays - Relays to query
 * @returns {Promise<Array>} - Array of post events with timestamps
 */
async function fetchNetworkPosts(pubkeys, since, relays = DEFAULT_RELAYS) {
  const pool = new SimplePool();
  const posts = [];
  
  try {
    // Fetch in batches to avoid overwhelming relays
    const batchSize = 100;
    const batches = [];
    
    for (let i = 0; i < pubkeys.length; i += batchSize) {
      batches.push(pubkeys.slice(i, i + batchSize));
    }
    
    for (const batch of batches) {
      const events = await pool.querySync(relays, {
        kinds: [1], // Regular notes
        authors: batch,
        since: since,
        limit: 1000, // Limit per batch
      });
      
      posts.push(...events);
    }
    
    return posts;
  } finally {
    pool.close(relays);
  }
}

/**
 * Convert pubkey to npub or vice versa
 */
function pubkeyToNpub(pubkey) {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

function npubToPubkey(npub) {
  try {
    if (npub.startsWith('npub')) {
      const { data } = nip19.decode(npub);
      return data;
    }
    return npub;
  } catch {
    return npub;
  }
}

/**
 * Scan a user's network and populate timing data
 * @param {number} userId - Internal user ID
 * @param {string} userPubkey - User's hex pubkey or npub
 * @param {string} period - '7d' | '30d' | '90d'
 * @returns {Promise<Object>} - Scan results
 */
async function scanUserNetwork(userId, userPubkey, period = '30d') {
  const pubkey = npubToPubkey(userPubkey);
  
  // Calculate since timestamp based on period
  const periodDays = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '6m': 180,
  };
  const days = periodDays[period] || 30;
  const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  
  console.log(`[Scanner] Starting network scan for user ${userId}`);
  console.log(`[Scanner] Period: ${period} (${days} days)`);
  
  // Step 1: Get following list
  console.log(`[Scanner] Fetching following list...`);
  const following = await getFollowingList(pubkey);
  console.log(`[Scanner] Found ${following.length} accounts being followed`);
  
  if (following.length === 0) {
    return {
      success: false,
      error: 'No following list found',
      following_count: 0,
      posts_found: 0,
    };
  }
  
  // Step 2: Store following list
  for (const followedPubkey of following) {
    try {
      await db.query(
        `INSERT INTO following (user_id, following_npub)
         VALUES ($1, $2)
         ON CONFLICT (user_id, following_npub) DO NOTHING`,
        [userId, pubkeyToNpub(followedPubkey)]
      );
    } catch (err) {
      // Ignore duplicates
    }
  }
  
  // Step 3: Fetch posts from following
  console.log(`[Scanner] Fetching posts from ${following.length} accounts...`);
  const posts = await fetchNetworkPosts(following, since);
  console.log(`[Scanner] Found ${posts.length} posts`);
  
  // Step 4: Store post activity data
  let stored = 0;
  for (const post of posts) {
    const postedAt = new Date(post.created_at * 1000);
    const hourGmt = postedAt.getUTCHours();
    
    try {
      await db.query(
        `INSERT INTO post_activity (user_id, author_npub, author_type, note_id, posted_at, hour_gmt)
         VALUES ($1, $2, 'following', $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [userId, pubkeyToNpub(post.pubkey), post.id, postedAt, hourGmt]
      );
      stored++;
    } catch (err) {
      // Ignore duplicates or errors
    }
  }
  
  console.log(`[Scanner] Stored ${stored} new post activity records`);
  
  // Step 5: Aggregate into network_activity
  await aggregatePostActivity(userId);
  
  return {
    success: true,
    following_count: following.length,
    posts_found: posts.length,
    posts_stored: stored,
    period: period,
    since: new Date(since * 1000).toISOString(),
  };
}

/**
 * Aggregate post_activity into network_activity hourly buckets
 * @param {number} userId - Internal user ID
 */
async function aggregatePostActivity(userId) {
  console.log(`[Scanner] Aggregating activity for user ${userId}...`);
  
  // Aggregate following posts by hour
  await db.query(`
    INSERT INTO network_activity (user_id, activity_type, hour_gmt, activity_count, window_date)
    SELECT 
      $1 as user_id,
      'following_post' as activity_type,
      hour_gmt,
      COUNT(*) as activity_count,
      CURRENT_DATE as window_date
    FROM post_activity
    WHERE user_id = $1 AND author_type = 'following'
    GROUP BY hour_gmt
    ON CONFLICT (user_id, activity_type, hour_gmt, window_date)
    DO UPDATE SET 
      activity_count = EXCLUDED.activity_count,
      created_at = NOW()
  `, [userId]);
  
  console.log(`[Scanner] Aggregation complete`);
}

/**
 * Quick scan - just get activity distribution without storing individual posts
 * Faster for immediate results
 * @param {string} userPubkey - User's hex pubkey or npub
 * @param {string} period - '7d' | '30d'
 * @returns {Promise<Object>} - Hourly distribution
 */
async function quickScanNetwork(userPubkey, period = '30d') {
  const pubkey = npubToPubkey(userPubkey);
  
  const periodDays = { '7d': 7, '30d': 30 };
  const days = periodDays[period] || 30;
  const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  
  // Get following
  const following = await getFollowingList(pubkey);
  
  if (following.length === 0) {
    return { error: 'No following list found', hourly_distribution: [] };
  }
  
  // Fetch posts
  const posts = await fetchNetworkPosts(following.slice(0, 200), since); // Limit to 200 accounts for speed
  
  // Calculate hourly distribution
  const hourlyCount = new Array(24).fill(0);
  for (const post of posts) {
    const hour = new Date(post.created_at * 1000).getUTCHours();
    hourlyCount[hour]++;
  }
  
  const hourlyDistribution = hourlyCount.map((count, hour) => ({
    hour_gmt: hour,
    activity_count: count,
  }));
  
  // Find peak hours
  const sorted = [...hourlyDistribution].sort((a, b) => b.activity_count - a.activity_count);
  const peakHours = sorted.slice(0, 3).map(h => h.hour_gmt);
  
  // Calculate zone of max participation (3-6 hour window with most activity)
  let bestZone = null;
  let maxActivity = 0;
  
  for (let windowSize = 3; windowSize <= 6; windowSize++) {
    for (let start = 0; start < 24; start++) {
      let activity = 0;
      for (let i = 0; i < windowSize; i++) {
        activity += hourlyCount[(start + i) % 24];
      }
      if (activity > maxActivity) {
        maxActivity = activity;
        const totalActivity = posts.length;
        bestZone = {
          start_hour_gmt: start,
          end_hour_gmt: (start + windowSize - 1) % 24,
          window_size: windowSize,
          total_activity: activity,
          percentage_of_total: totalActivity > 0 
            ? parseFloat(((activity / totalActivity) * 100).toFixed(1))
            : 0,
        };
      }
    }
  }
  
  return {
    following_count: following.length,
    posts_analyzed: posts.length,
    period,
    hourly_distribution: hourlyDistribution,
    peak_hours: peakHours,
    zone_of_max_participation: bestZone,
  };
}

module.exports = {
  getFollowingList,
  fetchNetworkPosts,
  scanUserNetwork,
  aggregatePostActivity,
  quickScanNetwork,
  npubToPubkey,
  pubkeyToNpub,
};
