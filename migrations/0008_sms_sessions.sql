CREATE TABLE IF NOT EXISTS sms_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  countrycode TEXT NOT NULL,
  cookie TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_sessions_user ON sms_sessions(user_id);
