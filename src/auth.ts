import { decryptText, encryptText, hashPassword, newId, nowSec, passwordNeedsRehash, randomHex, verifyPassword } from "./crypto";

export const SESSION_COOKIE = "nl_session";
const SESSION_DAYS = 7;

export type User = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  created_at: number;
  email: string | null;
};

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  return Response.json(data, { status, headers: extra });
}

export function err(message: string, status = 400): Response {
  return json({ ok: false, message }, status);
}

export function ok<T extends Record<string, unknown>>(data?: T, extra?: HeadersInit): Response {
  return json({ ok: true, ...(data || {}) }, 200, extra);
}

export function parseCookieHeader(request: Request, name: string): string {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function sessionCookie(token: string, maxAge = SESSION_DAYS * 86400): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export async function bootstrapAdmin(env: Env): Promise<void> {
  const username = (env.ADMIN_USERNAME || "admin").trim();
  const password = env.ADMIN_PASSWORD || "changeme123";
  const row = await env.DB.prepare("SELECT id, username, password_hash FROM users LIMIT 1").first<{
    id: string;
    username: string;
    password_hash: string;
  }>();
  if (row) {
    if (row.username === username && passwordNeedsRehash(row.password_hash)) {
      await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(hashPassword(password), row.id)
        .run();
    }
    return;
  }
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
  )
    .bind(id, username, hashPassword(password), nowSec())
    .run();
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, created_by, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(newId(), randomHex(4).slice(0, 8).toUpperCase(), id, nowSec())
    .run();
}

export async function getUserByToken(env: Env, token: string): Promise<User | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.status, u.created_at, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
  )
    .bind(token, nowSec())
    .first<{ id: string; username: string; role: string; status: string; created_at: number; email: string | null }>();
  if (!row || row.status !== "active") return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role === "admin" ? "admin" : "user",
    status: "active",
    created_at: row.created_at,
    email: row.email || null,
  };
}

export async function requireUser(env: Env, request: Request): Promise<User | Response> {
  const token = parseCookieHeader(request, SESSION_COOKIE);
  const user = await getUserByToken(env, token);
  if (!user) return err("请先登录", 401);
  return user;
}

export async function requireAdmin(env: Env, request: Request): Promise<User | Response> {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  if (user.role !== "admin") return err("需要管理员权限", 403);
  return user;
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomHex(24);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, nowSec() + SESSION_DAYS * 86400)
    .run();
  return token;
}

export { hashPassword, verifyPassword, encryptText, decryptText, newId, nowSec, randomHex, passwordNeedsRehash };
