/**
 * Network Scanner
 * Fetches historical activity from a user's network (following AND followers) from Nostr relays
 * to bootstrap timing analytics data
 * 
 * NOTE: This version uses raw WebSocket queries instead of nostr-tools
 * to avoid ESM/CommonJS compatibility issues on Railway
 */

const WebSocket = require('ws');
const db = require('./db');

// Default relays to query
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://purplepag.es',
];

// Relays that index follower data (can query for who follows a pubkey)
const INDEXING_RELAYS = [
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

/**
 * Query a relay for events using raw WebSocket
 */
async function queryRelay(relayUrl, filter, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const events = [];
    let resolved = false;
    let ws;
    
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { ws?.close(); } catch (e) {}
        resolve(events);
      }
    };
    
    const timeout = setTimeout(cleanup, timeoutMs);
    
    try {
      ws = new WebSocket(relayUrl);
      const subId = 'sub_' + Math.random().toString(36).slice(2);
      
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
    } catch (e) {
      clearTimeout(timeout);
      cleanup();
    }
  });
}

/**
 * Convert npub to hex pubkey using bech32 decoding
 */
function npubToPubkey(npub) {
  if (!npub) return npub;
  if (!npub.startsWith('npub1')) return npub; // Already hex
  
  const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = npub.slice(5);
  
  const values = [];
  for (const char of data) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid npub character: ' + char);
    values.push(idx);
  }
  
  let bits = 0;
  let value = 0;
  const result = [];
  
  for (const v of values.slice(0, -6)) { // Exclude 6-char checksum
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
 * Convert hex pubkey to npub
 */
function pubkeyToNpub(pubkey) {
  if (!pubkey) return pubkey;
  if (pubkey.startsWith('npub1')) return pubkey; // Already npub
  
  // Simple conversion - just prefix with npub format indicator
  // For display purposes, we'll use a truncated version
  return 'npub1' + pubkey.slice(0, 20) + '...';
}

/**
 * Get a user's following list from Nostr
 */
async function getFollowingList(pubkey, relays = DEFAULT_RELAYS) {
  console.log(`[Scanner] Fetching contact list for ${pubkey.slice(0, 8)}...`);
  
  for (const relay of relays) {
    try {
      const events = await queryRelay(relay, {
        kinds: [3], // Contact list
        authors: [pubkey],
        limit: 1
      }, 8000);
      
      if (events.length > 0) {
        const contactEvent = events[0];
        const following = (contactEvent.tags || [])
          .filter(tag => tag[0] === 'p')
          .map(tag => tag[1]);
        
        console.log(`[Scanner] Found ${following.length} contacts from ${relay}`);
        return following;
      }
    } catch (error) {
      console.log(`[Scanner] ${relay} failed:`, error.message);
    }
  }
  
  return [];
}

/**
 * Get a user's followers list from Nostr
 */
async function getFollowersList(pubkey, limit = 500) {
  console.log(`[Scanner] Fetching followers for ${pubkey.slice(0, 8)}...`);
  
  const allFollowers = new Set();
  
  for (const relay of INDEXING_RELAYS) {
    try {
      const events = await queryRelay(relay, {
        kinds: [3],
        '#p': [pubkey],
        limit: limit
      }, 15000);
      
      for (const event of events) {
        allFollowers.add(event.pubkey);
      }
      
      console.log(`[Scanner] Found ${allFollowers.size} followers from ${relay}`);
    } catch (error) {
      console.log(`[Scanner] ${relay} followers query failed:`, error.message);
    }
  }
  
  console.log(`[Scanner] Total unique followers: ${allFollowers.size}`);
  return Array.from(allFollowers);
}

/**
 * Fetch recent posts from a list of pubkeys
 */
async function fetchNetworkPosts(pubkeys, since, relays = DEFAULT_RELAYS) {
  const posts = [];
  const seen = new Set();
  
  // Limit to first 100 accounts for speed
  const limitedPubkeys = pubkeys.slice(0, 100);
  
  console.log(`[Scanner] Fetching posts from ${limitedPubkeys.length} accounts...`);
  
  for (const relay of relays.slice(0, 3)) {
    try {
      const events = await queryRelay(relay, {
        kinds: [1],
        authors: limitedPubkeys,
        since: since,
        limit: 500
      }, 15000);
      
      for (const event of events) {
        const key = `${event.pubkey}:${event.created_at}`;
        if (!seen.has(key)) {
          seen.add(key);
          posts.push({
            pubkey: event.pubkey,
            created_at: event.created_at,
            content: event.content,
            id: event.id
          });
        }
      }
      
      if (posts.length > 100) break; // Got enough
    } catch (error) {
      console.log(`[Scanner] ${relay} posts query failed:`, error.message);
    }
  }
  
  console.log(`[Scanner] Found ${posts.length} posts`);
  return posts;
}

/**
 * Calculate hourly distribution and zone of max participation from posts
 */
function calculateDistribution(posts) {
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
  
  return { hourlyDistribution, peakHours, bestZone };
}

/**
 * Quick scan - get activity distribution without storing individual posts
 * Faster for immediate results
 */
async function quickScanNetwork(userPubkey, period = '30d', mode = 'both') {
  const pubkey = npubToPubkey(userPubkey);
  
  const periodDays = { '7d': 7, '30d': 30, '90d': 90 };
  const days = periodDays[period] || 30;
  const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  
  const result = {
    pubkey: pubkey.slice(0, 8) + '...',
    period,
    mode,
    current_time_gmt: new Date().toISOString(),
  };
  
  // Fetch following data
  if (mode === 'following' || mode === 'both') {
    console.log(`[Scanner] Scanning following list...`);
    const following = await getFollowingList(pubkey);
    
    if (following.length > 0) {
      const posts = await fetchNetworkPosts(following, since);
      const { hourlyDistribution, peakHours, bestZone } = calculateDistribution(posts);
      
      result.following = {
        count: following.length,
        posts_analyzed: posts.length,
        hourly_distribution: hourlyDistribution,
        peak_hours: peakHours,
        zone_of_max_participation: bestZone,
      };
    } else {
      result.following = { count: 0, posts_analyzed: 0, error: 'No following list found' };
    }
  }
  
  // Fetch followers data
  if (mode === 'followers' || mode === 'both') {
    console.log(`[Scanner] Scanning followers list...`);
    const followers = await getFollowersList(pubkey, 300);
    
    if (followers.length > 0) {
      const posts = await fetchNetworkPosts(followers, since);
      const { hourlyDistribution, peakHours, bestZone } = calculateDistribution(posts);
      
      result.followers = {
        count: followers.length,
        posts_analyzed: posts.length,
        hourly_distribution: hourlyDistribution,
        peak_hours: peakHours,
        zone_of_max_participation: bestZone,
      };
    } else {
      result.followers = { count: 0, posts_analyzed: 0, error: 'No followers found' };
    }
  }
  
  // Calculate combined "both" distribution if requested
  if (mode === 'both' && result.following?.hourly_distribution && result.followers?.hourly_distribution) {
    const combinedHourly = result.following.hourly_distribution.map((h, i) => ({
      hour_gmt: h.hour_gmt,
      activity_count: h.activity_count + (result.followers.hourly_distribution[i]?.activity_count || 0),
    }));
    
    const sorted = [...combinedHourly].sort((a, b) => b.activity_count - a.activity_count);
    const combinedPeakHours = sorted.slice(0, 3).map(h => h.hour_gmt);
    
    const totalPosts = (result.following?.posts_analyzed || 0) + (result.followers?.posts_analyzed || 0);
    const hourlyCount = combinedHourly.map(h => h.activity_count);
    
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
          bestZone = {
            start_hour_gmt: start,
            end_hour_gmt: (start + windowSize - 1) % 24,
            window_size: windowSize,
            total_activity: activity,
            percentage_of_total: totalPosts > 0 
              ? parseFloat(((activity / totalPosts) * 100).toFixed(1))
              : 0,
          };
        }
      }
    }
    
    result.combined = {
      total_network: (result.following?.count || 0) + (result.followers?.count || 0),
      posts_analyzed: totalPosts,
      hourly_distribution: combinedHourly,
      peak_hours: combinedPeakHours,
      zone_of_max_participation: bestZone,
    };
  }
  
  return result;
}

/**
 * Scan a user's network and populate timing data
 */
async function scanUserNetwork(userId, userPubkey, period = '30d') {
  const pubkey = npubToPubkey(userPubkey);
  
  const periodDays = { '7d': 7, '30d': 30, '90d': 90, '6m': 180 };
  const days = periodDays[period] || 30;
  const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  
  console.log(`[Scanner] Starting network scan for user ${userId}`);
  console.log(`[Scanner] Period: ${period} (${days} days)`);
  
  // Get following list
  const following = await getFollowingList(pubkey);
  
  if (following.length === 0) {
    return {
      success: false,
      error: 'No following list found',
      following_count: 0,
      posts_found: 0,
    };
  }
  
  // Store following list
  for (const followedPubkey of following) {
    try {
      await db.query(
        `INSERT INTO following (user_id, following_npub)
         VALUES ($1, $2)
         ON CONFLICT (user_id, following_npub) DO NOTHING`,
        [userId, followedPubkey]
      );
    } catch (err) {}
  }
  
  // Fetch posts
  const posts = await fetchNetworkPosts(following, since);
  
  // Store post activity
  let stored = 0;
  for (const post of posts) {
    const postedAt = new Date(post.created_at * 1000);
    const hourGmt = postedAt.getUTCHours();
    
    try {
      await db.query(
        `INSERT INTO post_activity (user_id, author_npub, author_type, note_id, posted_at, hour_gmt)
         VALUES ($1, $2, 'following', $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [userId, post.pubkey, post.id, postedAt, hourGmt]
      );
      stored++;
    } catch (err) {}
  }
  
  console.log(`[Scanner] Stored ${stored} new post activity records`);
  
  // Aggregate
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
 */
async function aggregatePostActivity(userId) {
  console.log(`[Scanner] Aggregating activity for user ${userId}...`);
  
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

module.exports = {
  getFollowingList,
  getFollowersList,
  fetchNetworkPosts,
  scanUserNetwork,
  aggregatePostActivity,
  quickScanNetwork,
  npubToPubkey,
  pubkeyToNpub,
  queryRelay,
};
