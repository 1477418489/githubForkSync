CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  github_token TEXT,
  repositories TEXT NOT NULL DEFAULT '[]',
  sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (sync_enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes IN (15, 30, 60, 180, 360, 720, 1440)),
  revision INTEGER NOT NULL DEFAULT 1,
  auth_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  auth_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_expiry ON auth_attempts(expires_at);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lock_id TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  last_scheduled_at INTEGER NOT NULL DEFAULT 0,
  report_json TEXT
);
INSERT OR IGNORE INTO sync_state(id) VALUES (1);
