ALTER TABLE netease_accounts ADD COLUMN listen_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE netease_accounts ADD COLUMN next_listen_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE netease_accounts ADD COLUMN listening_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE netease_accounts ADD COLUMN report_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE netease_accounts ADD COLUMN pending_song_id TEXT;
ALTER TABLE netease_accounts ADD COLUMN pending_song_name TEXT;
ALTER TABLE netease_accounts ADD COLUMN pending_artist TEXT;
ALTER TABLE netease_accounts ADD COLUMN pending_duration INTEGER NOT NULL DEFAULT 0;
ALTER TABLE netease_accounts ADD COLUMN pending_source_id TEXT;

CREATE INDEX idx_netease_next_listen ON netease_accounts(status, next_listen_at);
CREATE INDEX idx_netease_report ON netease_accounts(status, report_at);
