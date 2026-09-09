/** Idempotent schema, same idea as nodewarden: CREATE TABLE IF NOT EXISTS on first request. */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    created_by TEXT,
    used_by TEXT,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS netease_accounts (
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
    listen_cursor INTEGER NOT NULL DEFAULT 0,
    next_listen_at INTEGER NOT NULL DEFAULT 0,
    listening_until INTEGER NOT NULL DEFAULT 0,
    report_at INTEGER NOT NULL DEFAULT 0,
    pending_song_id TEXT,
    pending_song_name TEXT,
    pending_artist TEXT,
    pending_duration INTEGER NOT NULL DEFAULT 0,
    pending_source_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS qr_sessions (
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
  )`,
  `CREATE TABLE IF NOT EXISTS playlist_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    playlist_id TEXT NOT NULL DEFAULT '',
    name TEXT,
    cover TEXT,
    track_count INTEGER NOT NULL DEFAULT 0,
    cursor INTEGER NOT NULL DEFAULT 0,
    listen_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    listen_started_at INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT OR IGNORE INTO playlist_meta (id, playlist_id, listen_enabled, updated_at) VALUES (1, '', 1, 0)`,
  `CREATE TABLE IF NOT EXISTS playlist_tracks (
    idx INTEGER PRIMARY KEY,
    song_id TEXT NOT NULL,
    name TEXT,
    artist TEXT,
    album TEXT,
    duration INTEGER,
    cover TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS listen_logs (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    user_id TEXT,
    song_id TEXT,
    song_name TEXT,
    artist TEXT,
    ok INTEGER NOT NULL,
    message TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_netease_user ON netease_accounts(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_listen_logs_created ON listen_logs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_invite_code ON invite_codes(code)`,
  `CREATE INDEX IF NOT EXISTS idx_netease_next_listen ON netease_accounts(status, next_listen_at)`,
  `CREATE INDEX IF NOT EXISTS idx_netease_report ON netease_accounts(status, report_at)`,
];

const MIGRATION_NAMES = [
  "0001_init.sql",
  "0002_listen_lock.sql",
  "0003_per_account_listen.sql",
  "0004_site_settings.sql",
];

export async function ensureStorageSchema(db: D1Database): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.prepare(sql).run();
  }
  for (const name of MIGRATION_NAMES) {
    await db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(name).run();
  }
}
