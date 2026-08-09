-- Portable schema: runs on MySQL/MariaDB (default), SQLite and PostgreSQL unchanged.
-- Timestamps are ISO-8601 strings; booleans are INTEGER 0/1; ids are UUIDs.
-- Ids/keys use VARCHAR (MySQL cannot index bare TEXT); long content uses TEXT.

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(512) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'CSR',            -- ADMIN | LEAD | CSR
  max_chats INTEGER NOT NULL DEFAULT 3,
  avatar_color VARCHAR(16) NOT NULL DEFAULT '#6366f1',
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  id VARCHAR(36) PRIMARY KEY,
  team_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  is_lead INTEGER NOT NULL DEFAULT 0,
  UNIQUE (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS websites (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  widget_key VARCHAR(64) NOT NULL UNIQUE,
  domains TEXT,                                        -- comma-separated hostnames; empty/null = allow all (dev)
  team_id VARCHAR(36) NOT NULL,
  logo_url TEXT,
  primary_color VARCHAR(16) NOT NULL DEFAULT '#6366f1',
  greeting VARCHAR(512) NOT NULL DEFAULT 'Hi there! How can we help?',
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS visitors (
  id VARCHAR(36) PRIMARY KEY,
  website_id VARCHAR(36) NOT NULL,
  name VARCHAR(255),
  email VARCHAR(255),
  created_at VARCHAR(32) NOT NULL,
  last_seen_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(36) PRIMARY KEY,
  website_id VARCHAR(36) NOT NULL,
  visitor_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'WAITING',       -- WAITING | OFFERED | ACTIVE | CLOSED | MISSED
  assigned_user_id VARCHAR(36),
  created_at VARCHAR(32) NOT NULL,
  activated_at VARCHAR(32),
  closed_at VARCHAR(32),
  rating INTEGER,                                      -- CSAT 1-5 (visitor, after close)
  rating_comment TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_website ON conversations (website_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned ON conversations (assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_visitor ON conversations (visitor_id, status);

-- CSAT columns (idempotent — duplicate-column errors are ignored by migrate())
ALTER TABLE conversations ADD COLUMN rating INTEGER;
ALTER TABLE conversations ADD COLUMN rating_comment TEXT;

-- Visitor IP + geo (idempotent)
ALTER TABLE visitors ADD COLUMN ip VARCHAR(64);
ALTER TABLE visitors ADD COLUMN geo_country VARCHAR(64);
ALTER TABLE visitors ADD COLUMN geo_city VARCHAR(64);

CREATE TABLE IF NOT EXISTS assignment_history (
  id VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  from_user_id VARCHAR(36),
  to_user_id VARCHAR(36) NOT NULL,
  reason VARCHAR(16) NOT NULL,                         -- AUTO | OFFER | TRANSFER
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  sender_type VARCHAR(16) NOT NULL,                    -- VISITOR | AGENT | SYSTEM
  sender_user_id VARCHAR(36),
  body TEXT,
  kind VARCHAR(16) NOT NULL DEFAULT 'TEXT',            -- TEXT | FILE | CALL | SYSTEM
  file_id VARCHAR(36),
  call_id VARCHAR(36),
  created_at VARCHAR(32) NOT NULL,
  delivered_at VARCHAR(32),
  read_at VARCHAR(32)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (conversation_id, sender_type, read_at);

CREATE TABLE IF NOT EXISTS files (
  id VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  uploader_type VARCHAR(16) NOT NULL,                  -- VISITOR | AGENT
  uploader_id VARCHAR(36) NOT NULL,
  original_name VARCHAR(512) NOT NULL,
  mime VARCHAR(255) NOT NULL,
  size INTEGER NOT NULL,
  scan_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',  -- PENDING | CLEAN | BLOCKED
  stored_path TEXT,                                    -- quarantine path (removed after compression)
  compressed_path TEXT,                                -- private gzip path served via authorized download
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  kind VARCHAR(16) NOT NULL,                           -- AUDIO | VIDEO
  provider VARCHAR(16) NOT NULL,                       -- BUILTIN | DAILY
  status VARCHAR(16) NOT NULL DEFAULT 'INVITED',       -- INVITED | ACTIVE | DECLINED | ENDED
  room_url TEXT,
  started_by VARCHAR(64) NOT NULL,                     -- 'AGENT:<userId>' | 'VISITOR:<visitorId>'
  created_at VARCHAR(32) NOT NULL,
  ended_at VARCHAR(32)
);

CREATE TABLE IF NOT EXISTS call_events (
  id VARCHAR(36) PRIMARY KEY,
  call_id VARCHAR(36) NOT NULL,
  participant VARCHAR(64) NOT NULL,                    -- 'AGENT:<userId>' | 'VISITOR:<visitorId>'
  event VARCHAR(16) NOT NULL,                          -- INVITED | JOIN | LEAVE | DECLINE | END
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_pages (
  id VARCHAR(36) PRIMARY KEY,
  website_id VARCHAR(36) NOT NULL,
  url TEXT NOT NULL,
  title VARCHAR(512),
  content TEXT,                                        -- extracted page text (capped ~50KB)
  fetched_at VARCHAR(32) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_website ON knowledge_pages (website_id);

-- Hot-path indexes for scale
CREATE INDEX IF NOT EXISTS idx_history_conversation ON assignment_history (conversation_id);
CREATE INDEX IF NOT EXISTS idx_files_conversation ON files (conversation_id);
CREATE INDEX IF NOT EXISTS idx_visitors_website ON visitors (website_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);
CREATE INDEX IF NOT EXISTS idx_calls_conversation ON calls (conversation_id);
