CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_by TEXT,
  used_by TEXT,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (used_by) REFERENCES users(id)
);

CREATE TABLE netease_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  netease_uid TEXT,
  nickname TEXT,
  avatar TEXT,
  cookie_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_listen_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE qr_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  unikey TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  cookie TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'wait',
  message TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE playlist_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  playlist_id TEXT NOT NULL DEFAULT '',
  name TEXT,
  cover TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER NOT NULL DEFAULT 0,
  listen_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

INSERT INTO playlist_meta (id, playlist_id, listen_enabled, updated_at)
VALUES (1, '', 1, 0);

CREATE TABLE playlist_tracks (
  idx INTEGER PRIMARY KEY,
  song_id TEXT NOT NULL,
  name TEXT,
  artist TEXT,
  album TEXT,
  duration INTEGER,
  cover TEXT
);

CREATE TABLE listen_logs (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  user_id TEXT,
  song_id TEXT,
  song_name TEXT,
  artist TEXT,
  ok INTEGER NOT NULL,
  message TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_exp ON sessions(expires_at);
CREATE INDEX idx_netease_user ON netease_accounts(user_id);
CREATE INDEX idx_listen_logs_created ON listen_logs(created_at DESC);
CREATE INDEX idx_invite_code ON invite_codes(code);
