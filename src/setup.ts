import { err } from "./auth";

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

export function dbNotReadyResponse(isApi: boolean): Response {
  const message =
    "数据库未就绪。请执行 npx wrangler d1 migrations apply netease-musician --remote（或把 Builds 部署命令改成 npm run deploy）后再访问。";
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
      ol { padding-left: 18px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>数据库还没接上</h1>
      <p>D1 绑定已按名字自动创建，但还没跑迁移，所以没有用户表。不必填 <code>database_id</code>。</p>
      <ol>
        <li>把 Workers Builds 的部署命令改成 <code>npm run deploy</code> 后重新部署，或本地执行 <code>npx wrangler d1 migrations apply netease-musician --remote</code></li>
        <li>刷新本页即可登录</li>
      </ol>
    </div>
  </body>
</html>`,
    {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}
