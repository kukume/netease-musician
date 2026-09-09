import {
  bootstrapAdmin,
  clearSessionCookie,
  createSession,
  encryptText,
  err,
  hashPassword,
  newId,
  nowSec,
  ok,
  randomHex,
  parseCookieHeader,
  readJson,
  requireAdmin,
  requireUser,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
  type User,
} from "./auth";
import {
  checkQrcode,
  fetchAccount,
  getQrcode,
  QrWaitError,
} from "./netease";
import { getPlaylistMeta, kickListen, listTracks, randomListenAt, savePlaylist } from "./listen";
import { qrToSvg } from "./qr";
import { publicCapConfig, verifyCapToken } from "./cap";

const PAGE_SIZE = 15;

function pageParams(request: Request, defaultSize = PAGE_SIZE) {
  const url = new URL(request.url);
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1) || 1));
  const pageSize = Math.min(50, Math.max(5, Math.floor(Number(url.searchParams.get("pageSize") || defaultSize) || defaultSize)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function publicUser(u: User) {
  return { id: u.id, username: u.username, role: u.role, status: u.status, createdAt: u.created_at };
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  await bootstrapAdmin(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  try {
    if (method === "GET" && path === "/api/cap/widget") return capWidget(env);

    if (method === "POST" && path === "/api/auth/register") return register(env, request);
    if (method === "POST" && path === "/api/auth/login") return login(env, request);
    if (method === "POST" && path === "/api/auth/logout") {
      return ok({}, { "Set-Cookie": clearSessionCookie() });
    }
    if (method === "POST" && path === "/api/auth/password") return changePassword(env, request);
    if (method === "GET" && path === "/api/me") return me(env, request);

    if (method === "GET" && path === "/api/overview") return overview(env, request);
    if (method === "GET" && path === "/api/logs") return myLogs(env, request);

    if (method === "POST" && path === "/api/netease/qrcode") return createQr(env, request);
    if (method === "GET" && path.startsWith("/api/netease/qrcode/")) {
      return pollQr(env, request, path.slice("/api/netease/qrcode/".length));
    }
    if (method === "GET" && path === "/api/netease/accounts") return listAccounts(env, request);
    if (method === "DELETE" && path.startsWith("/api/netease/accounts/")) {
      return deleteAccount(env, request, path.slice("/api/netease/accounts/".length));
    }

    if (method === "GET" && path === "/api/admin/users") return adminUsers(env, request);
    if (method === "PATCH" && path.startsWith("/api/admin/users/")) {
      return patchUser(env, request, path.slice("/api/admin/users/".length));
    }
    if (method === "DELETE" && path.startsWith("/api/admin/users/")) {
      return deleteUser(env, request, path.slice("/api/admin/users/".length));
    }
    if (method === "GET" && path === "/api/admin/invites") return listInvites(env, request);
    if (method === "POST" && path === "/api/admin/invites") return createInvite(env, request);
    if (method === "DELETE" && path.startsWith("/api/admin/invites/")) {
      return deleteInvite(env, request, path.slice("/api/admin/invites/".length));
    }
    if (method === "GET" && path === "/api/admin/playlist") return adminPlaylist(env, request);
    if (method === "PUT" && path === "/api/admin/playlist") return setPlaylist(env, request);
    if (method === "POST" && path === "/api/admin/playlist/refresh") return refreshPlaylist(env, request);
    if (method === "PUT" && path === "/api/admin/listen") return setListen(env, request);
    if (method === "POST" && path === "/api/admin/listen/run") return manualListen(env, request);
    if (method === "GET" && path === "/api/admin/logs") return adminLogs(env, request);

    return err("接口不存在", 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message || "服务器错误", 500);
  }
}

async function register(env: Env, request: Request) {
  const body = await readJson<{ username?: string; password?: string; inviteCode?: string; "cap-token"?: string; capToken?: string }>(request);
  const capFail = await verifyCapToken(env, body["cap-token"] || body.capToken);
  if (capFail) return capFail;
  const username = (body.username || "").trim();
  const password = body.password || "";
  const inviteCode = (body.inviteCode || "").trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return err("用户名需为 3-20 位字母、数字或下划线");
  if (password.length < 6) return err("密码至少 6 位");
  if (!inviteCode) return err("请填写邀请码");

  const invite = await env.DB.prepare("SELECT id, used_by FROM invite_codes WHERE code = ?")
    .bind(inviteCode)
    .first<{ id: string; used_by: string | null }>();
  if (!invite) return err("邀请码无效");
  if (invite.used_by) return err("邀请码已被使用");

  const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (exists) return err("用户名已存在");

  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', ?)",
    ).bind(id, username, hashPassword(password), nowSec()),
    env.DB.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ?").bind(id, nowSec(), invite.id),
  ]);
  const token = await createSession(env, id);
  return ok({ user: { id, username, role: "user", status: "active" } }, { "Set-Cookie": sessionCookie(token) });
}

async function login(env: Env, request: Request) {
  const body = await readJson<{ username?: string; password?: string; "cap-token"?: string; capToken?: string }>(request);
  const capFail = await verifyCapToken(env, body["cap-token"] || body.capToken);
  if (capFail) return capFail;
  const username = (body.username || "").trim();
  const password = body.password || "";
  const row = await env.DB.prepare("SELECT id, username, password_hash, role, status, created_at FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: string; username: string; password_hash: string; role: string; status: string; created_at: number }>();
  if (!row || !verifyPassword(password, row.password_hash)) return err("用户名或密码错误", 401);
  if (row.status !== "active") return err("账号已被停用", 403);
  const token = await createSession(env, row.id);
  return ok(
    { user: publicUser({ id: row.id, username: row.username, role: row.role === "admin" ? "admin" : "user", status: "active", created_at: row.created_at }) },
    { "Set-Cookie": sessionCookie(token) },
  );
}

async function me(env: Env, request: Request) {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  return ok({ user: publicUser(user) });
}

async function changePassword(env: Env, request: Request) {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  const body = await readJson<{ oldPassword?: string; newPassword?: string }>(request);
  const oldPassword = body.oldPassword || "";
  const newPassword = body.newPassword || "";
  if (newPassword.length < 6) return err("新密码至少 6 位");
  if (oldPassword === newPassword) return err("新密码不能与当前密码相同");
  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!row || !verifyPassword(oldPassword, row.password_hash)) return err("当前密码不正确");
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(hashPassword(newPassword), user.id)
    .run();
  const token = parseCookieHeader(request, SESSION_COOKIE);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").bind(user.id, token).run();
  return ok({ message: "密码已更新" });
}

async function overview(env: Env, request: Request) {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  const meta = await getPlaylistMeta(env);
  const { page, pageSize, offset } = pageParams(request);
  const tracksTotal = Number(meta?.track_count || 0);
  const tracks = await listTracks(env, pageSize, offset);
  const now = nowSec();
  const accounts = await env.DB.prepare(
    `SELECT id, netease_uid as neteaseUid, nickname, avatar, status, last_listen_at as lastListenAt, last_error as lastError,
            next_listen_at as nextListenAt, report_at as reportAt, listen_cursor as listenCursor,
            pending_song_id as pendingSongId, pending_song_name as pendingSongName, pending_artist as pendingArtist
     FROM netease_accounts WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all();
  const stats = await env.DB.prepare(
    "SELECT COUNT(*) as bound FROM netease_accounts",
  ).first<{ bound: number }>();
  const listening = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM netease_accounts WHERE pending_song_id IS NOT NULL AND report_at > ?",
  )
    .bind(now)
    .first<{ n: number }>();
  const current = await env.DB.prepare(
    `SELECT a.pending_song_id as songId, a.pending_song_name as name, a.pending_artist as artist, t.cover
     FROM netease_accounts a
     LEFT JOIN playlist_tracks t ON t.song_id = a.pending_song_id
     WHERE a.user_id = ? AND a.pending_song_id IS NOT NULL AND a.report_at > ?
     ORDER BY a.report_at ASC LIMIT 1`,
  )
    .bind(user.id, now)
    .first();
  return ok({
    playlist: meta
      ? {
          id: meta.playlist_id,
          name: meta.name,
          cover: meta.cover,
          trackCount: meta.track_count,
          cursor: meta.cursor,
          listenEnabled: !!meta.listen_enabled,
        }
      : null,
    current,
    tracks,
    tracksPage: page,
    tracksPageSize: pageSize,
    tracksTotal,
    tracksTotalPages: Math.max(1, Math.ceil(tracksTotal / pageSize)),
    accounts: accounts.results || [],
    boundCount: stats?.bound || 0,
    listeningCount: listening?.n || 0,
  });
}

async function myLogs(env: Env, request: Request) {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  const { page, pageSize, offset } = pageParams(request);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) as n FROM listen_logs WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();
  const total = Number(totalRow?.n || 0);
  const { results } = await env.DB.prepare(
    `SELECT id, song_id as songId, song_name as songName, artist, ok, message, created_at as createdAt
     FROM listen_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, pageSize, offset)
    .all();
  return ok({ logs: results || [], page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}

async function createQr(env: Env, request: Request) {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  const qr = await getQrcode();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO qr_sessions (id, user_id, unikey, chain_id, cookie, url, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'wait', ?, ?)`,
  )
    .bind(id, user.id, qr.unikey, qr.chainId, qr.cookie, qr.url, nowSec(), nowSec() + 180)
    .run();
  return ok({ id, url: qr.url, qrSvg: qrToSvg(qr.url), expiresIn: 180 });
}

async function pollQr(env: Env, request: Request, id: string) {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  const row = await env.DB.prepare("SELECT * FROM qr_sessions WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first<{
      id: string;
      unikey: string;
      chain_id: string;
      cookie: string;
      url: string;
      status: string;
      expires_at: number;
    }>();
  if (!row) return err("二维码不存在", 404);
  if (row.status === "ok") return ok({ status: "ok", message: "绑定成功" });
  if (nowSec() > row.expires_at) {
    await env.DB.prepare("UPDATE qr_sessions SET status = 'expired', message = ? WHERE id = ?")
      .bind("二维码已过期", id)
      .run();
    return ok({ status: "expired", message: "二维码已过期，请刷新" });
  }
  try {
    const login = await checkQrcode({
      unikey: row.unikey,
      url: row.url,
      chainId: row.chain_id,
      cookie: row.cookie,
    });
    let profile = { uid: "", nickname: "网易云用户", avatar: "" };
    try {
      profile = await fetchAccount(login.cookie);
    } catch {
      const p = (login.profile || {}) as Record<string, unknown>;
      const nested = (p.profile as Record<string, unknown> | undefined) || {};
      const account = (p.account as Record<string, unknown> | undefined) || {};
      profile = {
        uid: String(nested.userId || p.userId || account.id || p.userId || ""),
        nickname: String(nested.nickname || p.nickname || "网易云用户"),
        avatar: String(nested.avatarUrl || p.avatarUrl || ""),
      };
    }
    const cookieEnc = await encryptText(env.SESSION_SECRET, login.cookie);
    const nextAt = randomListenAt();
    const existing = profile.uid
      ? await env.DB.prepare("SELECT id FROM netease_accounts WHERE user_id = ? AND netease_uid = ?")
          .bind(user.id, profile.uid)
          .first<{ id: string }>()
      : null;
    if (existing) {
      await env.DB.prepare(
        `UPDATE netease_accounts
         SET nickname = ?, avatar = ?, cookie_enc = ?, status = 'active', last_error = NULL,
             next_listen_at = CASE WHEN pending_song_id IS NOT NULL THEN next_listen_at ELSE ? END
         WHERE id = ?`,
      )
        .bind(profile.nickname, profile.avatar, cookieEnc, nextAt, existing.id)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO netease_accounts (id, user_id, netease_uid, nickname, avatar, cookie_enc, status, created_at, next_listen_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
        .bind(newId(), user.id, profile.uid || null, profile.nickname, profile.avatar, cookieEnc, nowSec(), nextAt)
        .run();
    }
    await env.DB.prepare("UPDATE qr_sessions SET status = 'ok', message = ?, cookie = '' WHERE id = ?")
      .bind("绑定成功", id)
      .run();
    return ok({ status: "ok", message: "绑定成功", profile });
  } catch (e) {
    if (e instanceof QrWaitError) {
      const status = e.code === 802 ? "scanned" : e.code === 800 ? "expired" : "wait";
      await env.DB.prepare("UPDATE qr_sessions SET status = ?, message = ? WHERE id = ?")
        .bind(status, e.message, id)
        .run();
      return ok({ status, message: e.message });
    }
    const message = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE qr_sessions SET status = 'error', message = ? WHERE id = ?")
      .bind(message, id)
      .run();
    return err(message);
  }
}

async function listAccounts(env: Env, request: Request) {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  const { results } = await env.DB.prepare(
    `SELECT id, netease_uid as neteaseUid, nickname, avatar, status, last_listen_at as lastListenAt, last_error as lastError, created_at as createdAt,
            next_listen_at as nextListenAt, report_at as reportAt, pending_song_id as pendingSongId, pending_song_name as pendingSongName
     FROM netease_accounts WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all();
  return ok({ accounts: results || [] });
}

async function deleteAccount(env: Env, request: Request, id: string) {
  const user = await requireUser(env, request);
  if (user instanceof Response) return user;
  const row = await env.DB.prepare("SELECT id FROM netease_accounts WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!row && user.role !== "admin") return err("账号不存在", 404);
  if (user.role === "admin") {
    await env.DB.prepare("DELETE FROM netease_accounts WHERE id = ?").bind(id).run();
  } else {
    await env.DB.prepare("DELETE FROM netease_accounts WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  }
  return ok();
}

async function adminUsers(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const { page, pageSize, offset } = pageParams(request);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) as n FROM users").first<{ n: number }>();
  const total = Number(totalRow?.n || 0);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.status, u.created_at as createdAt,
            (SELECT COUNT(*) FROM netease_accounts a WHERE a.user_id = u.id) as bound
     FROM users u ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(pageSize, offset)
    .all();
  return ok({ users: results || [], page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}

async function patchUser(env: Env, request: Request, id: string) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  if (id === admin.id) return err("不能修改自己的角色或状态");
  const body = await readJson<{ role?: string; status?: string }>(request);
  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
  if (!user) return err("用户不存在", 404);
  if (body.role === "admin" || body.role === "user") {
    await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(body.role, id).run();
  }
  if (body.status === "active" || body.status === "disabled") {
    await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(body.status, id).run();
    if (body.status === "disabled") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    }
  }
  return ok();
}

async function deleteUser(env: Env, request: Request, id: string) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  if (id === admin.id) return err("不能删除自己");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM netease_accounts WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return ok();
}

async function listInvites(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const { page, pageSize, offset } = pageParams(request);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) as n FROM invite_codes").first<{ n: number }>();
  const total = Number(totalRow?.n || 0);
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.code, i.created_at as createdAt, i.used_at as usedAt,
            u.username as usedBy
     FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by
     ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(pageSize, offset)
    .all();
  return ok({ invites: results || [], page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}

async function createInvite(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const body = await readJson<{ count?: number }>(request).catch(() => ({ count: 1 }));
  const count = Math.min(20, Math.max(1, Number(body.count || 1)));
  const codes: string[] = [];
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const code = randomHex(4).slice(0, 8).toUpperCase();
    codes.push(code);
    stmts.push(
      env.DB.prepare("INSERT INTO invite_codes (id, code, created_by, created_at) VALUES (?, ?, ?, ?)").bind(
        newId(),
        code,
        admin.id,
        nowSec(),
      ),
    );
  }
  await env.DB.batch(stmts);
  return ok({ codes });
}

async function deleteInvite(env: Env, request: Request, id: string) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  await env.DB.prepare("DELETE FROM invite_codes WHERE id = ? AND used_by IS NULL").bind(id).run();
  return ok();
}

async function adminPlaylist(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const meta = await getPlaylistMeta(env);
  const { page, pageSize, offset } = pageParams(request);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) as n FROM playlist_tracks").first<{ n: number }>();
  const total = Number(totalRow?.n || 0);
  const tracks = await listTracks(env, pageSize, offset);
  return ok({
    playlist: meta,
    tracks,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

async function setPlaylist(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const body = await readJson<{ playlist?: string }>(request);
  if (!body.playlist) return err("请填写歌单 ID 或链接");
  const result = await savePlaylist(env, body.playlist);
  return ok(result);
}

async function refreshPlaylist(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const meta = await getPlaylistMeta(env);
  if (!meta?.playlist_id) return err("还没有保存歌单");
  const result = await savePlaylist(env, meta.playlist_id);
  return ok(result);
}

async function setListen(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const body = await readJson<{ enabled?: boolean }>(request);
  await env.DB.prepare("UPDATE playlist_meta SET listen_enabled = ?, updated_at = ? WHERE id = 1")
    .bind(body.enabled ? 1 : 0, nowSec())
    .run();
  return ok({ listenEnabled: !!body.enabled });
}

async function manualListen(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const result = await kickListen(env);
  return ok(result);
}

async function adminLogs(env: Env, request: Request) {
  const admin = await requireAdmin(env, request);
  if (admin instanceof Response) return admin;
  const { page, pageSize, offset } = pageParams(request);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) as n FROM listen_logs").first<{ n: number }>();
  const total = Number(totalRow?.n || 0);
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.song_id as songId, l.song_name as songName, l.artist, l.ok, l.message, l.created_at as createdAt,
            u.username, a.nickname
     FROM listen_logs l
     LEFT JOIN users u ON u.id = l.user_id
     LEFT JOIN netease_accounts a ON a.id = l.account_id
     ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(pageSize, offset)
    .all();
  return ok({ logs: results || [], page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}

async function capWidget(env: Env) {
  return ok(publicCapConfig(env));
}

