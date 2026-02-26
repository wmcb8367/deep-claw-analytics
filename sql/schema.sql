-- Deep Claw Analytics Database Schema
-- Multi-user Nostr analytics platform

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  npub TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  webhook_url TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  api_token TEXT UNIQUE NOT NULL,
  tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'premium')),
  created_at TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP DEFAULT NOW(),
  settings JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_users_npub ON users(npub);
CREATE INDEX idx_users_api_token ON users(api_token);

-- Events table (raw Nostr events)
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('mention', 'reply', 'follow', 'zap', 'repost', 'like')),
  author_npub TEXT NOT NULL,
  author_name TEXT,
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL,
  processed BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_events_user_id ON events(user_id);
CREATE INDEX idx_events_event_type ON events(event_type);
CREATE INDEX idx_events_created_at ON events(created_at DESC);
CREATE INDEX idx_events_processed ON events(processed) WHERE processed = FALSE;

-- Posts table (user's own posts with engagement tracking)
CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT UNIQUE NOT NULL,
  content TEXT,
  likes INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  zaps_count INTEGER DEFAULT 0,
  zaps_sats BIGINT DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  posted_at TIMESTAMP NOT NULL,
  last_updated TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_posted_at ON posts(posted_at DESC);

-- Metrics table (calculated stats over time)
CREATE TABLE IF NOT EXISTS metrics (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  metric_type TEXT NOT NULL,
  value NUMERIC NOT NULL,
  period TEXT CHECK (period IN ('hourly', 'daily', 'weekly', 'monthly')),
  calculated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_metrics_user_id ON metrics(user_id);
CREATE INDEX idx_metrics_type ON metrics(metric_type);
CREATE INDEX idx_metrics_calculated_at ON metrics(calculated_at DESC);

-- Followers table (track follower growth)
CREATE TABLE IF NOT EXISTS followers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  follower_npub TEXT NOT NULL,
  follower_name TEXT,
  follower_count INTEGER DEFAULT 0,
  followed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, follower_npub)
);

CREATE INDEX idx_followers_user_id ON followers(user_id);
CREATE INDEX idx_followers_followed_at ON followers(followed_at DESC);

-- Engagers table (track who engages with user's content)
CREATE TABLE IF NOT EXISTS engagers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  engager_npub TEXT NOT NULL,
  engager_name TEXT,
  interactions INTEGER DEFAULT 1,
  last_interaction TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, engager_npub)
);

CREATE INDEX idx_engagers_user_id ON engagers(user_id);
CREATE INDEX idx_engagers_interactions ON engagers(interactions DESC);

-- Webhook logs (track webhook deliveries)
CREATE TABLE IF NOT EXISTS webhook_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT CHECK (status IN ('pending', 'sent', 'failed')),
  response_code INTEGER,
  error_message TEXT,
  sent_at TIMESTAMP DEFAULT NOW(),
  retry_count INTEGER DEFAULT 0
);

CREATE INDEX idx_webhook_logs_user_id ON webhook_logs(user_id);
CREATE INDEX idx_webhook_logs_status ON webhook_logs(status);
CREATE INDEX idx_webhook_logs_sent_at ON webhook_logs(sent_at DESC);

-- API usage tracking (for rate limiting)
CREATE TABLE IF NOT EXISTS api_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  request_count INTEGER DEFAULT 1,
  window_start TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, endpoint, window_start)
);

CREATE INDEX idx_api_usage_user_id ON api_usage(user_id);
CREATE INDEX idx_api_usage_window ON api_usage(window_start DESC);

-- Insert default admin user (for testing)
-- npub: Willie's @deepclaw account
-- webhook_url: OpenClaw webhook endpoint
-- api_token: randomly generated
INSERT INTO users (npub, webhook_url, webhook_secret, api_token, tier)
VALUES (
  'npub1deepclaw', -- Replace with actual npub
  'http://localhost:18789/webhooks/deep-claw',
  'test-secret-change-in-production',
  'dc_test_token_change_in_production',
  'free'
) ON CONFLICT (npub) DO NOTHING;
