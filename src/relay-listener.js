#!/usr/bin/env node

/**
 * Nostr Relay Listener
 * Monitors multiple relays for events related to registered users
 */

const { SimplePool, nip19 } = require('nostr-tools');
const db = require('./db');
const config = require('./config');
const webhookSender = require('./webhook-sender');

const pool = new SimplePool();
let userNpubs = new Map(); // npub -> user_id mapping
let activeSubscriptions = [];

/**
 * Load all registered users from database
 */
async function loadUsers() {
  try {
    const result = await db.query('SELECT id, npub FROM users');
    
    userNpubs.clear();
    result.rows.forEach(user => {
      userNpubs.set(user.npub, user.id);
    });
    
    console.log(`Loaded ${userNpubs.size} users to monitor`);
    return Array.from(userNpubs.keys());
  } catch (error) {
    console.error('Failed to load users:', error);
    return [];
  }
}

/**
 * Convert npub to hex pubkey
 */
function npubToHex(npub) {
  try {
    const decoded = nip19.decode(npub);
    return decoded.data;
  } catch (error) {
    console.error(`Invalid npub ${npub}:`, error.message);
    return null;
  }
}

/**
 * Process mention event
 */
async function processMention(event, userId) {
  try {
    // Check if already processed
    const existing = await db.query(
      'SELECT id FROM events WHERE event_id = $1',
      [event.id]
    );
    
    if (existing.rows.length > 0) return;
    
    // Store event
    await db.query(
      `INSERT INTO events (user_id, event_id, event_type, author_npub, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
      [
        userId,
        event.id,
        'mention',
        event.pubkey,
        event.content,
        JSON.stringify(event),
        event.created_at
      ]
    );
    
    // Update engagers table
    await db.query(
      `INSERT INTO engagers (user_id, engager_npub, interactions, last_interaction)
       VALUES ($1, $2, 1, to_timestamp($3))
       ON CONFLICT (user_id, engager_npub)
       DO UPDATE SET 
         interactions = engagers.interactions + 1,
         last_interaction = to_timestamp($3)`,
      [userId, event.pubkey, event.created_at]
    );
    
    console.log(`📬 Mention for user ${userId} from ${event.pubkey.substring(0, 8)}...`);
    
    // Send webhook
    await webhookSender.sendMentionWebhook(userId, event);
    
  } catch (error) {
    console.error('Error processing mention:', error);
  }
}

/**
 * Process follow event (kind 3)
 */
async function processFollow(event, userId) {
  try {
    // kind 3 events contain the follow list in tags
    // Check if our user's pubkey is in the p tags
    const userHexPubkey = npubToHex(Array.from(userNpubs.keys()).find(npub => userNpubs.get(npub) === userId));
    
    if (!userHexPubkey) return;
    
    const isFollowing = event.tags.some(tag => 
      tag[0] === 'p' && tag[1] === userHexPubkey
    );
    
    if (!isFollowing) return;
    
    // Check if already recorded
    const existing = await db.query(
      'SELECT id FROM followers WHERE user_id = $1 AND follower_npub = $2',
      [userId, event.pubkey]
    );
    
    if (existing.rows.length > 0) return;
    
    // Add follower
    await db.query(
      `INSERT INTO followers (user_id, follower_npub, followed_at)
       VALUES ($1, $2, to_timestamp($3))`,
      [userId, event.pubkey, event.created_at]
    );
    
    console.log(`👥 New follower for user ${userId}: ${event.pubkey.substring(0, 8)}...`);
    
    // Send webhook
    await webhookSender.sendFollowerWebhook(userId, event);
    
  } catch (error) {
    console.error('Error processing follow:', error);
  }
}

/**
 * Process zap event (kind 9735)
 */
async function processZap(event, userId) {
  try {
    // Extract zap amount from bolt11 invoice
    let satsAmount = 0;
    const bolt11Tag = event.tags.find(tag => tag[0] === 'bolt11');
    
    if (bolt11Tag) {
      // Parse amount from invoice (simplified - would need proper parser)
      // For now, store the event and we can parse amount later
      satsAmount = 0; // TODO: implement proper invoice parsing
    }
    
    // Store event
    await db.query(
      `INSERT INTO events (user_id, event_id, event_type, author_npub, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
      [
        userId,
        event.id,
        'zap',
        event.pubkey,
        event.content || '',
        JSON.stringify(event),
        event.created_at
      ]
    );
    
    console.log(`⚡ Zap received for user ${userId} from ${event.pubkey.substring(0, 8)}...`);
    
    // Send webhook
    await webhookSender.sendZapWebhook(userId, event, satsAmount);
    
  } catch (error) {
    console.error('Error processing zap:', error);
  }
}

/**
 * Subscribe to events for all users
 */
async function subscribeToEvents() {
  const npubs = await loadUsers();
  
  if (npubs.length === 0) {
    console.log('No users to monitor. Waiting...');
    return;
  }
  
  // Convert npubs to hex pubkeys
  const pubkeys = npubs.map(npubToHex).filter(Boolean);
  
  if (pubkeys.length === 0) {
    console.error('No valid pubkeys found');
    return;
  }
  
  console.log(`Subscribing to ${config.nostr.relays.length} relays for ${pubkeys.length} users...`);
  
  // Close existing subscriptions
  activeSubscriptions.forEach(sub => sub.unsub());
  activeSubscriptions = [];
  
  // Subscribe to mentions (kind 1 events that mention our users)
  const mentionSub = pool.sub(config.nostr.relays, [
    {
      kinds: [1],
      '#p': pubkeys,
      since: Math.floor(Date.now() / 1000) - 3600 // Last hour
    }
  ]);
  
  mentionSub.on('event', async (event) => {
    // Find which user(s) were mentioned
    for (const tag of event.tags) {
      if (tag[0] === 'p') {
        const mentionedPubkey = tag[1];
        const npub = Object.keys(Object.fromEntries(userNpubs)).find(npub => 
          npubToHex(npub) === mentionedPubkey
        );
        
        if (npub) {
          const userId = userNpubs.get(npub);
          await processMention(event, userId);
        }
      }
    }
  });
  
  activeSubscriptions.push(mentionSub);
  
  // Subscribe to follow lists (kind 3) mentioning our users
  const followSub = pool.sub(config.nostr.relays, [
    {
      kinds: [3],
      '#p': pubkeys,
      since: Math.floor(Date.now() / 1000) - 86400 // Last 24h
    }
  ]);
  
  followSub.on('event', async (event) => {
    // Check which user was followed
    for (const tag of event.tags) {
      if (tag[0] === 'p') {
        const followedPubkey = tag[1];
        const npub = Object.keys(Object.fromEntries(userNpubs)).find(npub => 
          npubToHex(npub) === followedPubkey
        );
        
        if (npub) {
          const userId = userNpubs.get(npub);
          await processFollow(event, userId);
        }
      }
    }
  });
  
  activeSubscriptions.push(followSub);
  
  // Subscribe to zaps (kind 9735)
  const zapSub = pool.sub(config.nostr.relays, [
    {
      kinds: [9735],
      '#p': pubkeys,
      since: Math.floor(Date.now() / 1000) - 3600
    }
  ]);
  
  zapSub.on('event', async (event) => {
    // Find which user received the zap
    for (const tag of event.tags) {
      if (tag[0] === 'p') {
        const zappedPubkey = tag[1];
        const npub = Object.keys(Object.fromEntries(userNpubs)).find(npub => 
          npubToHex(npub) === zappedPubkey
        );
        
        if (npub) {
          const userId = userNpubs.get(npub);
          await processZap(event, userId);
        }
      }
    }
  });
  
  activeSubscriptions.push(zapSub);
  
  console.log('✅ Subscribed to Nostr events');
}

/**
 * Reload users periodically (in case new ones register)
 */
async function periodicReload() {
  console.log('🔄 Reloading user list...');
  await subscribeToEvents();
}

/**
 * Start the relay listener
 */
async function start() {
  console.log('🦞 Deep Claw Analytics Relay Listener Starting...');
  console.log(`Monitoring relays: ${config.nostr.relays.join(', ')}`);
  
  await subscribeToEvents();
  
  // Reload users every 5 minutes
  setInterval(periodicReload, 5 * 60 * 1000);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down relay listener...');
  activeSubscriptions.forEach(sub => sub.unsub());
  pool.close(config.nostr.relays);
  process.exit(0);
});

// Start if run directly
if (require.main === module) {
  start().catch(console.error);
}

module.exports = { start, loadUsers };
