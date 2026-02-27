-- Agent API Tables
-- Stores events, posts, and engagement data for AI agent management

-- Events table: stores all activity (reactions, replies, mentions, zaps, follows)
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- 'reaction', 'reply', 'mention', 'zap', 'follow', 'repost'
  event_data JSONB NOT NULL, -- Full event data
  acknowledged BOOLEAN DEFAULT false, -- Has agent acknowledged/acted on this?
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_events_user_type (user_id, type),
  INDEX idx_events_user_ack (user_id, acknowledged),
  INDEX idx_events_created (created_at)
);

-- Posts table: stores user's posts with engagement metrics
CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id VARCHAR(255) NOT NULL UNIQUE, -- Nostr note ID (nevent or note1...)
  content TEXT NOT NULL,
  image_url TEXT,
  posted_at TIMESTAMP NOT NULL,
  reactions INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_posts_user_posted (user_id, posted_at),
  INDEX idx_posts_note_id (note_id)
);

-- Create trigger to update posts.updated_at on changes
CREATE OR REPLACE FUNCTION update_posts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posts_updated_at_trigger
  BEFORE UPDATE ON posts
  FOR EACH ROW
  EXECUTE FUNCTION update_posts_updated_at();

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ack ON events(type, acknowledged);
CREATE INDEX IF NOT EXISTS idx_posts_user_posted_desc ON posts(user_id, posted_at DESC);
