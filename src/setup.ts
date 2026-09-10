import { err } from "./auth";
import { applyPendingMigrations, ensureStorageSchema } from "./schema";

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

let schemaReady = false;

/** Create tables on first request. Git Builds 不会跑 wrangler d1 migrations apply. */
export async function ensureSchema(env: Env): Promise<boolean> {
  if (schemaReady) return true;
  if (!hasDbBinding(env)) return false;
  if (await isDatabaseReady(env)) {
    try {
      await applyPendingMigrations(env.DB);
    } catch (error) {
      console.error("[db] migrate failed", error);
    }
    schemaReady = true;
    return true;
  }
  try {
    await ensureStorageSchema(env.DB);
  } catch (error) {
    console.error("[db] migrate failed", error);
  }
  schemaReady = await isDatabaseReady(env);
  return schemaReady;
}

export function dbNotReadyResponse(isApi: boolean): Response {
  const message = "数据库未就绪：Worker 没有 D1 绑定。请确认 wrangler.jsonc 里 database_name 为 netease-musician 后重新部署。";
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
      p { color: #9b97ad; line-height: 1.7; }
      code { color: #efc56d; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>数据库还没接上</h1>
      <p>当前 Worker 拿不到 D1。请确认仓库 <code>wrangler.jsonc</code> 里 Worker 名和 D1 名字都是 <code>netease-musician</code>，然后重新部署。</p>
    </div>
  </body>
</html>`,
    {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}
