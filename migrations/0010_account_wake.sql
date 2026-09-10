ALTER TABLE netease_accounts ADD COLUMN wake_kind TEXT;
ALTER TABLE netease_accounts ADD COLUMN wake_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE netease_accounts ADD COLUMN wake_token TEXT;
CREATE INDEX IF NOT EXISTS idx_netease_wake ON netease_accounts(status, wake_at);
