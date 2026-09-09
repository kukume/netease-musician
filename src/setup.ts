import { err } from "./auth";
import sql0001 from "../migrations/0001_init.sql";
import sql0002 from "../migrations/0002_listen_lock.sql";
import sql0003 from "../migrations/0003_per_account_listen.sql";
import sql0004 from "../migrations/0004_site_settings.sql";

const MIGRATIONS = [
  { name: "0001_init.sql", sql: sql0001 },
  { name: "0002_listen_lock.sql", sql: sql0002 },
  { name: "0003_per_account_listen.sql", sql: sql0003 },
  { name: "0004_site_settings.sql", sql: sql0004 },
] as const;

export function hasDbBinding(env: Env): boolean {
  return typeof env.DB?.prepare === "function";
}

export async function isDatabaseReady(env: Env): Promise<boolean> {
  if (!hasDbBinding(env)) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    ).first<{ name: string }>();
    return !!row?.name;
  } catch {
    return false;
  }
}

async function applyPendingMigrations(env: Env): Promise<void> {
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`);

  const applied = await env.DB.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const done = new Set((applied.results || []).map((row) => row.name));

  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) continue;
    await env.DB.exec(migration.sql);
    await env.DB.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(migration.name).run();
  }
}

/** Create tables on first request if Wrangler did not apply migrations (Workers Builds). */
export async function ensureSchema(env: Env): Promise<boolean> {
  if (!hasDbBinding(env)) return false;
  if (await isDatabaseReady(env)) return true;
  try {
    await applyPendingMigrations(env);
  } catch (error) {
    console.error("[db] migrate failed", error);
  }
  return isDatabaseReady(env);
}

export function dbNotReadyResponse(isApi: boolean): Response {
  const message = "数据库未就绪：Worker 没有 D1 绑定。请确认 wrangler.jsonc 里 d1_databases 的 database_name 为 netease-musician 后重新部署。";
  if (isApi) return err(message, 503);
  return new Response(
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>数据库未就绪 · 云村互助</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: "Noto Sans SC", sans-serif; background: #07070c; color: #f6f4f8; }
      .card { width: min(520px, calc(100% - 32px)); padding: 28px; border-radius: 22px; background: rgba(24,24,36,.92); border: 1px solid rgba(255,255,255,.08); }
      h1 { margin: 0 0 10px; font-size: 22px; }
      p, li { color: #9b97ad; line-height: 1.7; }
      code { color: #efc56d; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>数据库还没接上</h1>
      <p>当前 Worker 拿不到 D1。请确认仓库 <code>wrangler.jsonc</code> 里 Worker 名为 <code>netease-musician</code>，D1 名字为 <code>netease-musician</code>，然后重新部署。</p>
    </div>
  </body>
</html>`,
    {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}
