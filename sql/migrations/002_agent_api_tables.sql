-- Agent API Tables
-- Stores events, posts, and engagement data for AI agent management

-- Events table: stores all activity (reactions, replies, mentions, zaps, follows)
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  event_data JSONB NOT NULL,
  acknowledged BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Posts table: stores user's posts with engagement metrics
CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id VARCHAR(255) NOT NULL UNIQUE,
  content TEXT NOT NULL,
  image_url TEXT,
  posted_at TIMESTAMP NOT NULL,
  reactions INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for events
CREATE INDEX IF NOT EXISTS idx_events_user_type ON events(user_id, type);
CREATE INDEX IF NOT EXISTS idx_events_user_ack ON events(user_id, acknowledged);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ack ON events(type, acknowledged);

-- Indexes for posts
CREATE INDEX IF NOT EXISTS idx_posts_user_posted ON posts(user_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_posts_note_id ON posts(note_id);
CREATE INDEX IF NOT EXISTS idx_posts_user_posted_desc ON posts(user_id, posted_at DESC);

-- Trigger for posts.updated_at
CREATE OR REPLACE FUNCTION update_posts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS posts_updated_at_trigger ON posts;
CREATE TRIGGER posts_updated_at_trigger
  BEFORE UPDATE ON posts
  FOR EACH ROW
  EXECUTE FUNCTION update_posts_updated_at();

-- Timing cache table for frontend
CREATE TABLE IF NOT EXISTS timing_cache (
  id SERIAL PRIMARY KEY,
  npub VARCHAR(255) NOT NULL,
  data JSONB NOT NULL,
  period VARCHAR(10) NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(npub, period)
);

CREATE INDEX IF NOT EXISTS idx_timing_cache_npub ON timing_cache(npub, period);
