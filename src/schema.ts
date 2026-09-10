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
  `CREATE TABLE IF NOT EXISTS sms_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    countrycode TEXT NOT NULL,
    cookie TEXT NOT NULL,
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
    cover TEXT,
    artist_ids TEXT
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
  `INSERT OR IGNORE INTO site_settings (key, value) VALUES ('listen_work', '{"owner":"","phase":"idle","expiresAt":0}')`,
  `INSERT OR IGNORE INTO site_settings (key, value) VALUES ('listen_cron', '{"at":0,"status":"idle","wallMs":0,"started":0,"reported":0,"leftoverStarts":0,"leftoverReports":0}')`,
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
  `CREATE INDEX IF NOT EXISTS idx_sms_sessions_user ON sms_sessions(user_id)`,
];

/** Bundled copies of migrations/*.sql so the Worker can apply them without wrangler CLI. */
const FILE_MIGRATIONS: { name: string; statements: string[] }[] = [
  {
    name: "0002_listen_lock.sql",
    statements: ["ALTER TABLE playlist_meta ADD COLUMN listen_started_at INTEGER NOT NULL DEFAULT 0"],
  },
  {
    name: "0003_per_account_listen.sql",
    statements: [
      "ALTER TABLE netease_accounts ADD COLUMN listen_cursor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE netease_accounts ADD COLUMN next_listen_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE netease_accounts ADD COLUMN listening_until INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE netease_accounts ADD COLUMN report_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE netease_accounts ADD COLUMN pending_song_id TEXT",
      "ALTER TABLE netease_accounts ADD COLUMN pending_song_name TEXT",
      "ALTER TABLE netease_accounts ADD COLUMN pending_artist TEXT",
      "ALTER TABLE netease_accounts ADD COLUMN pending_duration INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE netease_accounts ADD COLUMN pending_source_id TEXT",
      "CREATE INDEX IF NOT EXISTS idx_netease_next_listen ON netease_accounts(status, next_listen_at)",
      "CREATE INDEX IF NOT EXISTS idx_netease_report ON netease_accounts(status, report_at)",
    ],
  },
  {
    name: "0004_site_settings.sql",
    statements: [
      "CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    ],
  },
  {
    name: "0005_listen_work.sql",
    statements: [
      `INSERT OR IGNORE INTO site_settings (key, value) VALUES ('listen_work', '{"owner":"","phase":"idle","expiresAt":0}')`,
    ],
  },
  {
    name: "0006_listen_cron.sql",
    statements: [
      `INSERT OR IGNORE INTO site_settings (key, value) VALUES ('listen_cron', '{"at":0,"status":"idle","wallMs":0,"started":0,"reported":0,"leftoverStarts":0,"leftoverReports":0}')`,
    ],
  },
  {
    name: "0007_track_artist_ids.sql",
    statements: ["ALTER TABLE playlist_tracks ADD COLUMN artist_ids TEXT"],
  },
  {
    name: "0008_sms_sessions.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS sms_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        countrycode TEXT NOT NULL,
        cookie TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_sms_sessions_user ON sms_sessions(user_id)",
    ],
  },
];

function isIgnorableMigrationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("duplicate column") ||
    lower.includes("already exists") ||
    lower.includes("duplicate key")
  );
}

async function appliedMigrationNames(db: D1Database): Promise<Set<string>> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`,
    )
    .run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  return new Set((results || []).map((row) => row.name));
}

export async function listMigrations(db: D1Database): Promise<{ applied: string[]; pending: string[] }> {
  const applied = await appliedMigrationNames(db);
  const names = FILE_MIGRATIONS.map((m) => m.name);
  return {
    applied: ["0001_init.sql", ...names].filter((name) => applied.has(name)),
    pending: names.filter((name) => !applied.has(name)),
  };
}

export async function applyPendingMigrations(db: D1Database): Promise<{
  applied: string[];
  pending: string[];
  ran: string[];
}> {
  const done = await appliedMigrationNames(db);
  if (!done.has("0001_init.sql")) {
    await db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind("0001_init.sql").run();
    done.add("0001_init.sql");
  }

  const ran: string[] = [];
  for (const migration of FILE_MIGRATIONS) {
    if (done.has(migration.name)) continue;
    for (const sql of migration.statements) {
      try {
        await db.prepare(sql).run();
      } catch (error) {
        if (!isIgnorableMigrationError(error)) throw error;
      }
    }
    await db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(migration.name).run();
    done.add(migration.name);
    ran.push(migration.name);
  }

  const listed = await listMigrations(db);
  return { ...listed, ran };
}

export async function ensureStorageSchema(db: D1Database): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.prepare(sql).run();
  }
  await applyPendingMigrations(db);
}
