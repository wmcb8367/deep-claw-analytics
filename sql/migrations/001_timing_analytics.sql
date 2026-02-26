-- Migration: Add timing analytics tables
-- Date: 2026-02-26

-- Network activity tracking (hourly buckets in GMT)
CREATE TABLE IF NOT EXISTS network_activity (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('follower_post', 'following_post', 'engagement')),
  hour_gmt INTEGER NOT NULL CHECK (hour_gmt >= 0 AND hour_gmt < 24),
  activity_count INTEGER DEFAULT 1,
  window_date DATE NOT NULL, -- For filtering by time period
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, activity_type, hour_gmt, window_date)
);

CREATE INDEX idx_network_activity_user ON network_activity(user_id);
CREATE INDEX idx_network_activity_type ON network_activity(activity_type);
CREATE INDEX idx_network_activity_window ON network_activity(window_date DESC);
CREATE INDEX idx_network_activity_hour ON network_activity(hour_gmt);

-- Following table (track who user follows, for activity analysis)
CREATE TABLE IF NOT EXISTS following (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  following_npub TEXT NOT NULL,
  following_name TEXT,
  followed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, following_npub)
);

CREATE INDEX idx_following_user_id ON following(user_id);
CREATE INDEX idx_following_npub ON following(following_npub);

-- Post activity (track when followers/following post, for timing analysis)
CREATE TABLE IF NOT EXISTS post_activity (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  author_npub TEXT NOT NULL,
  author_type TEXT CHECK (author_type IN ('follower', 'following', 'self')),
  note_id TEXT NOT NULL,
  posted_at TIMESTAMP NOT NULL,
  hour_gmt INTEGER, -- Computed in application code instead of generated column
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_post_activity_user ON post_activity(user_id);
CREATE INDEX idx_post_activity_author ON post_activity(author_npub);
CREATE INDEX idx_post_activity_type ON post_activity(author_type);
CREATE INDEX idx_post_activity_posted ON post_activity(posted_at DESC);
CREATE INDEX idx_post_activity_hour ON post_activity(hour_gmt);

-- Insights cache (pre-calculated recommendations)
CREATE TABLE IF NOT EXISTS insights (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  insight_type TEXT NOT NULL, -- No CHECK constraint - allows dynamic cache keys
  data JSONB NOT NULL,
  period TEXT CHECK (period IN ('24h', '7d', '30d', '6m', 'all')),
  calculated_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  UNIQUE(user_id, insight_type, period)
);

CREATE INDEX idx_insights_user ON insights(user_id);
CREATE INDEX idx_insights_type ON insights(insight_type);
CREATE INDEX idx_insights_expires ON insights(expires_at);

-- API tokens table (for persistent, long-lived access)
CREATE TABLE IF NOT EXISTS api_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL, -- e.g., "Sebastian's OpenClaw Access"
  scopes TEXT[] DEFAULT ARRAY['read:metrics', 'read:events'], -- Permission scopes
  last_used TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP, -- NULL = never expires
  revoked BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_api_tokens_token ON api_tokens(token);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX idx_api_tokens_revoked ON api_tokens(revoked) WHERE revoked = FALSE;

COMMENT ON TABLE network_activity IS 'Aggregated hourly activity counts for timing analysis';
COMMENT ON TABLE post_activity IS 'Raw post timestamps from followers/following for activity pattern analysis';
COMMENT ON TABLE insights IS 'Pre-calculated insights and recommendations (cached)';
COMMENT ON TABLE api_tokens IS 'Long-lived API tokens with scopes, separate from user registration tokens';
