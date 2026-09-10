import { decryptText, newId, nowSec } from "./crypto";
import {
  assertCookieValid,
  CookieExpiredError,
  fetchPublicPlaylist,
  finishPlaySession,
  MIN_REPORT_SECONDS,
  parsePlaylistId,
  startPlaySession,
  type PlaylistTrack,
} from "./netease";

const CLAIM_SECONDS = 90;
const MAX_STARTS_PER_TICK = 6;
const MAX_REPORTS_PER_TICK = 40;
const MAX_SONG_TRIES = 3;
const CONCURRENCY = 3;
const TICK_BUDGET_MS = 45_000;
const REPORT_STALE_SEC = 10 * 60;
const CRON_HEALTHY_SEC = 180;
const GAP_MIN_SEC = 40;
const GAP_MAX_SEC = 180;
const SCATTER_MAX_SEC = 240;
const WORK_LOCK_KEY = "listen_work";
const WORK_LOCK_IDLE = '{"owner":"","phase":"idle","expiresAt":0}';
const WORK_LOCK_TTL_SEC = 90;
const HEARTBEAT_KEY = "listen_cron";

function randInt(min: number, max: number): number {
  const span = max - min + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % span);
}

export function randomListenAt(now = nowSec(), maxSec = 120): number {
  return now + randInt(0, Math.max(0, maxSec));
}

function nextGapSec(): number {
  return randInt(GAP_MIN_SEC, GAP_MAX_SEC);
}

function listenLog(step: string, detail?: string) {
  console.log(detail ? `[listen] ${step} ${detail}` : `[listen] ${step}`);
}

function who(account: { id: string; nickname?: string | null }) {
  return `account="${account.nickname || "未命名"}" id=${account.id.slice(0, 8)}`;
}

function overBudget(deadline: number): boolean {
  return Date.now() >= deadline;
}

async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>, deadline: number): Promise<{ outcomes: R[]; leftover: number }> {
  const outcomes: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    if (overBudget(deadline)) return { outcomes, leftover: items.length - i };
    const chunk = items.slice(i, i + CONCURRENCY);
    outcomes.push(...(await Promise.all(chunk.map(fn))));
  }
  return { outcomes, leftover: 0 };
}

type WorkLock = {
  owner: string;
  phase: string;
  expiresAt: number;
};

export type CronHeartbeat = {
  at: number;
  status: "ok" | "busy" | "error" | "idle";
  wallMs: number;
  started: number;
  reported: number;
  leftoverStarts: number;
  leftoverReports: number;
  message?: string;
  ageSec: number;
  healthy: boolean;
};

async function ensureWorkLockRow(env: Env) {
  await env.DB.prepare("INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)").bind(WORK_LOCK_KEY, WORK_LOCK_IDLE).run();
}

async function readWorkLock(env: Env): Promise<WorkLock> {
  const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = ?").bind(WORK_LOCK_KEY).first<{ value: string }>();
  try {
    const value = JSON.parse(row?.value || WORK_LOCK_IDLE) as Partial<WorkLock>;
    return {
      owner: String(value.owner || ""),
      phase: String(value.phase || "idle"),
      expiresAt: Number(value.expiresAt || 0),
    };
  } catch {
    return { owner: "", phase: "idle", expiresAt: 0 };
  }
}

async function tryAcquireWork(env: Env, owner: string, phase: string): Promise<boolean> {
  await ensureWorkLockRow(env);
  const now = nowSec();
  const expires = now + WORK_LOCK_TTL_SEC;
  const result = await env.DB.prepare(
    `UPDATE site_settings
     SET value = json_object('owner', ?, 'phase', ?, 'expiresAt', ?)
     WHERE key = ?
     AND (
       coalesce(json_extract(value, '$.owner'), '') = ''
       OR coalesce(json_extract(value, '$.expiresAt'), 0) <= ?
     )`,
  )
    .bind(owner, phase, expires, WORK_LOCK_KEY, now)
    .run();
  return Number(result.meta.changes || 0) > 0;
}

async function releaseWork(env: Env, owner: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE site_settings SET value = ? WHERE key = ? AND coalesce(json_extract(value, '$.owner'), '') = ?`,
  )
    .bind(WORK_LOCK_IDLE, WORK_LOCK_KEY, owner)
    .run();
}

async function acquireWorkOrSkip(env: Env, owner: string, phase: string): Promise<boolean> {
  if (await tryAcquireWork(env, owner, phase)) {
    listenLog("work.hold", `owner=${owner.slice(0, 8)} phase=${phase} ttl=${WORK_LOCK_TTL_SEC}s`);
    return true;
  }
  const lock = await readWorkLock(env);
  listenLog("work.skip", `busy=${lock.phase || "unknown"} 上一次开听还在跑，本分钟只上报`);
  return false;
}

async function writeHeartbeat(env: Env, data: Omit<CronHeartbeat, "ageSec" | "healthy">): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)").bind(HEARTBEAT_KEY, JSON.stringify(data)).run();
}

export async function getCronHeartbeat(env: Env): Promise<CronHeartbeat> {
  const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = ?").bind(HEARTBEAT_KEY).first<{ value: string }>();
  const now = nowSec();
  try {
    const value = JSON.parse(row?.value || "{}") as Partial<CronHeartbeat>;
    const at = Number(value.at || 0);
    const status = value.status === "ok" || value.status === "busy" || value.status === "error" ? value.status : "idle";
    const ageSec = at ? Math.max(0, now - at) : 0;
    return {
      at,
      status,
      wallMs: Number(value.wallMs || 0),
      started: Number(value.started || 0),
      reported: Number(value.reported || 0),
      leftoverStarts: Number(value.leftoverStarts || 0),
      leftoverReports: Number(value.leftoverReports || 0),
      message: value.message ? String(value.message).slice(0, 200) : undefined,
      ageSec,
      healthy: at > 0 && ageSec < CRON_HEALTHY_SEC && status !== "error",
    };
  } catch {
    return {
      at: 0,
      status: "idle",
      wallMs: 0,
      started: 0,
      reported: 0,
      leftoverStarts: 0,
      leftoverReports: 0,
      ageSec: 0,
      healthy: false,
    };
  }
}

type AccountRow = {
  id: string;
  user_id: string;
  cookie_enc: string;
  nickname: string | null;
  listen_cursor: number;
  pending_song_id: string | null;
  pending_song_name: string | null;
  pending_artist: string | null;
  pending_duration: number;
  pending_source_id: string | null;
};

export async function savePlaylist(env: Env, input: string): Promise<{ name: string; cover: string; trackCount: number }> {
  const playlistId = parsePlaylistId(input);
  const info = await fetchPublicPlaylist(playlistId);
  if (!info.tracks.length) throw new Error("歌单为空或无法读取歌曲");

  await env.DB.prepare("DELETE FROM playlist_tracks").run();
  await env.DB.prepare(
    `UPDATE playlist_meta
     SET playlist_id = ?, name = ?, cover = ?, track_count = ?, cursor = 0, updated_at = ?
     WHERE id = 1`,
  )
    .bind(info.playlistId, info.name, info.cover, info.tracks.length, nowSec())
    .run();

  for (let i = 0; i < info.tracks.length; i += 40) {
    const chunk = info.tracks.slice(i, i + 40).map((t, offset) =>
      env.DB.prepare(
        "INSERT INTO playlist_tracks (idx, song_id, name, artist, album, duration, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(i + offset, t.songId, t.name, t.artist, t.album, t.duration, t.cover),
    );
    await env.DB.batch(chunk);
  }

  const now = nowSec();
  await env.DB.prepare(
    `UPDATE netease_accounts
     SET listen_cursor = 0,
         next_listen_at = CASE
           WHEN pending_song_id IS NOT NULL THEN next_listen_at
           ELSE ? + (ABS(RANDOM()) % ?)
         END
     WHERE status = 'active'`,
  )
    .bind(now, SCATTER_MAX_SEC)
    .run();

  return { name: info.name, cover: info.cover, trackCount: info.tracks.length };
}

export async function getPlaylistMeta(env: Env) {
  return env.DB.prepare("SELECT * FROM playlist_meta WHERE id = 1").first<{
    playlist_id: string;
    name: string | null;
    cover: string | null;
    track_count: number;
    cursor: number;
    listen_enabled: number;
    listen_started_at?: number;
    updated_at: number;
  }>();
}

export async function listTracks(env: Env, limit?: number, offset = 0): Promise<PlaylistTrack[]> {
  if (!limit) {
    const { results } = await env.DB.prepare(
      "SELECT song_id as songId, name, artist, album, duration, cover FROM playlist_tracks ORDER BY idx ASC",
    ).all<PlaylistTrack>();
    return results || [];
  }
  const { results } = await env.DB.prepare(
    "SELECT song_id as songId, name, artist, album, duration, cover FROM playlist_tracks ORDER BY idx ASC LIMIT ? OFFSET ?",
  )
    .bind(limit, offset)
    .all<PlaylistTrack>();
  return results || [];
}

export async function scatterIdleAccounts(env: Env, withinSec = SCATTER_MAX_SEC): Promise<number> {
  const now = nowSec();
  const result = await env.DB.prepare(
    `UPDATE netease_accounts
     SET next_listen_at = ? + (ABS(RANDOM()) % ?)
     WHERE status = 'active' AND pending_song_id IS NULL AND listening_until <= ?`,
  )
    .bind(now, Math.max(1, withinSec), now)
    .run();
  const n = Number(result.meta.changes || 0);
  listenLog("scatter", `idle=${n} within=${withinSec}s`);
  return n;
}

async function trimLogs(env: Env) {
  const countRow = await env.DB.prepare("SELECT COUNT(*) as n FROM listen_logs").first<{ n: number }>();
  if ((countRow?.n || 0) <= 800) return;
  const cutoff = await env.DB.prepare(
    "SELECT created_at FROM listen_logs ORDER BY created_at DESC LIMIT 1 OFFSET 800",
  ).first<{ created_at: number }>();
  if (cutoff) {
    await env.DB.prepare("DELETE FROM listen_logs WHERE created_at < ?").bind(cutoff.created_at).run();
  }
}

function shouldTrimLogs(): boolean {
  return new Date().getUTCMinutes() % 10 === 0;
}

async function writeLog(
  env: Env,
  account: { id: string; user_id: string },
  song: { songId: string; name: string; artist: string },
  ok: number,
  message: string,
) {
  await env.DB.prepare(
    `INSERT INTO listen_logs (id, account_id, user_id, song_id, song_name, artist, ok, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId(), account.id, account.user_id, song.songId, song.name, song.artist, ok, message.slice(0, 500), nowSec())
    .run();
}

async function markAccountError(
  env: Env,
  accountId: string,
  expired: boolean,
  message: string,
  nextListenAt: number,
  listenCursor?: number,
) {
  await env.DB.prepare(
    `UPDATE netease_accounts
     SET status = ?, last_listen_at = ?, last_error = ?,
         listening_until = 0, report_at = 0,
         pending_song_id = NULL, pending_song_name = NULL, pending_artist = NULL,
         pending_duration = 0, pending_source_id = NULL,
         next_listen_at = ?${listenCursor != null ? ", listen_cursor = ?" : ""}
     WHERE id = ?`,
  )
    .bind(
      expired ? "expired" : "active",
      nowSec(),
      message.slice(0, 500),
      expired ? 0 : nextListenAt,
      ...(listenCursor != null ? [listenCursor] : []),
      accountId,
    )
    .run();
}

async function reportOne(env: Env, accountId: string): Promise<"ok" | "fail" | "skip" | "stale"> {
  const now = nowSec();
  const claimed = await env.DB.prepare(
    `UPDATE netease_accounts
     SET listening_until = ?
     WHERE id = ? AND status = 'active' AND pending_song_id IS NOT NULL AND report_at > 0 AND report_at <= ? AND listening_until <= ?`,
  )
    .bind(now + CLAIM_SECONDS, accountId, now, now)
    .run();
  if (claimed.meta.changes === 0) {
    listenLog("report.skip", `id=${accountId.slice(0, 8)} 未到期或已上报`);
    return "skip";
  }

  const account = await env.DB.prepare(
    `SELECT id, user_id, cookie_enc, nickname, pending_song_id, pending_song_name, pending_artist,
            pending_duration, pending_source_id, report_at
     FROM netease_accounts WHERE id = ?`,
  )
    .bind(accountId)
    .first<AccountRow & { report_at: number }>();
  if (!account?.pending_song_id) {
    listenLog("report.skip", `id=${accountId.slice(0, 8)} 没有待上报歌曲`);
    return "skip";
  }

  const song = {
    songId: account.pending_song_id || "",
    name: account.pending_song_name || "未知歌曲",
    artist: account.pending_artist || "",
  };

  if (Number(account.report_at || 0) <= now - REPORT_STALE_SEC) {
    const message = "上报过期，已跳过";
    listenLog("report.stale", `${who(account)} song=${song.songId} ${song.name}`);
    await writeLog(env, account, song, 0, message);
    await markAccountError(env, account.id, false, message, now + nextGapSec());
    return "stale";
  }

  listenLog(
    "report.start",
    `${who(account)} song=${song.songId} ${song.name} duration=${account.pending_duration}s`,
  );
  try {
    const cookie = await decryptText(env.SESSION_SECRET, account.cookie_enc);
    const result = await finishPlaySession(
      cookie,
      song.songId,
      Number(account.pending_duration || 0),
      account.pending_source_id || undefined,
    );
    listenLog("report.done", `${who(account)} ok=${result.ok} ${result.message}`);
    await writeLog(env, account, song, result.ok ? 1 : 0, result.message);
    await env.DB.prepare(
      `UPDATE netease_accounts
       SET status = 'active', last_listen_at = ?, last_error = ?,
           listening_until = 0, report_at = 0,
           pending_song_id = NULL, pending_song_name = NULL, pending_artist = NULL,
           pending_duration = 0, pending_source_id = NULL,
           next_listen_at = ?
       WHERE id = ?`,
    )
      .bind(nowSec(), result.ok ? null : result.message.slice(0, 500), nowSec() + nextGapSec(), account.id)
      .run();
    return result.ok ? "ok" : "fail";
  } catch (e) {
    const expired = e instanceof CookieExpiredError;
    const message = e instanceof Error ? e.message : String(e);
    listenLog("report.fail", `${who(account)} expired=${expired} ${message}`);
    await writeLog(env, account, song, 0, message);
    await markAccountError(env, account.id, expired, message, nowSec() + nextGapSec());
    return "fail";
  }
}

async function finishDueReports(env: Env, deadline: number): Promise<{ success: number; fail: number; leftover: number }> {
  const now = nowSec();
  const dueRow = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM netease_accounts
     WHERE pending_song_id IS NOT NULL AND report_at > 0 AND report_at <= ? AND status = 'active' AND listening_until <= ?`,
  )
    .bind(now, now)
    .first<{ n: number }>();
  const dueCount = Number(dueRow?.n || 0);

  const { results } = await env.DB.prepare(
    `SELECT id FROM netease_accounts
     WHERE pending_song_id IS NOT NULL AND report_at > 0 AND report_at <= ? AND status = 'active' AND listening_until <= ?
     ORDER BY report_at ASC
     LIMIT ?`,
  )
    .bind(now, now, MAX_REPORTS_PER_TICK)
    .all<{ id: string }>();

  listenLog("report.due", `count=${results?.length || 0} total=${dueCount}`);
  const { outcomes, leftover: budgetLeft } = await mapPool(results || [], (row) => reportOne(env, row.id), deadline);
  let success = 0;
  let fail = 0;
  for (const outcome of outcomes) {
    if (outcome === "ok") success += 1;
    else if (outcome === "fail" || outcome === "stale") fail += 1;
  }
  const leftover = budgetLeft + Math.max(0, dueCount - (results?.length || 0));
  return { success, fail, leftover };
}

async function startOneAccount(
  env: Env,
  account: AccountRow,
  playlistId: string,
  trackCount: number,
  deadline: number,
): Promise<{ started: number; fail: number }> {
  const claimed = await env.DB.prepare(
    `UPDATE netease_accounts
     SET listening_until = ?
     WHERE id = ? AND status = 'active' AND pending_song_id IS NULL AND listening_until <= ?`,
  )
    .bind(nowSec() + CLAIM_SECONDS, account.id, nowSec())
    .run();
  if (claimed.meta.changes === 0) {
    listenLog("start.skip", `${who(account)} 未抢到锁（同时只听一首）`);
    return { started: 0, fail: 0 };
  }

  const n = Math.max(trackCount, 1);
  let idx = Number(account.listen_cursor || 0) % n;

  let cookie: string;
  try {
    cookie = await decryptText(env.SESSION_SECRET, account.cookie_enc);
    const me = await assertCookieValid(cookie);
    listenLog("cookie.ok", `${who(account)} uid=${me.uid} nickname="${me.nickname}"`);
  } catch (e) {
    const expired = e instanceof CookieExpiredError;
    const message = e instanceof Error ? e.message : String(e);
    listenLog("start.fail", `${who(account)} expired=${expired} ${expired ? "个人资料接口判定登录失效" : message}`);
    await markAccountError(env, account.id, expired, message, expired ? 0 : nowSec() + nextGapSec(), idx);
    return { started: 0, fail: 1 };
  }

  for (let attempt = 0; attempt < MAX_SONG_TRIES; attempt += 1) {
    if (overBudget(deadline)) {
      await env.DB.prepare(
        `UPDATE netease_accounts SET listening_until = 0, listen_cursor = ?, next_listen_at = ? WHERE id = ?`,
      )
        .bind(idx, nowSec(), account.id)
        .run();
      listenLog("start.defer", `${who(account)} 本轮超时，游标=${idx} 留给下一分钟`);
      return { started: 0, fail: 0 };
    }

    const nextCursor = (idx + 1) % n;
    const track = await env.DB.prepare(
      "SELECT song_id as songId, name, artist, album, duration, cover FROM playlist_tracks WHERE idx = ?",
    )
      .bind(idx)
      .first<PlaylistTrack>();
    if (!track) {
      listenLog("start.fail", `${who(account)} idx=${idx} 歌单没有对应歌曲，跳到下一首 next=${nextCursor}`);
      await env.DB.prepare("UPDATE netease_accounts SET listen_cursor = ? WHERE id = ?").bind(nextCursor, account.id).run();
      idx = nextCursor;
      continue;
    }

    listenLog("start.begin", `${who(account)} idx=${idx} try=${attempt + 1}/${MAX_SONG_TRIES} song=${track.songId} ${track.name} / ${track.artist}`);
    try {
      const { durationS } = await startPlaySession(cookie, track.songId, {
        fallbackDurationMs: track.duration,
      });
      if (durationS <= MIN_REPORT_SECONDS) {
        const message = `歌曲过短，未上报 play（需 > ${MIN_REPORT_SECONDS}s）`;
        listenLog("start.skip-short", `${who(account)} duration=${durationS}s 跳到下一首 next=${nextCursor}`);
        await writeLog(env, account, track, 0, message);
        await env.DB.prepare("UPDATE netease_accounts SET listen_cursor = ?, last_error = ? WHERE id = ?")
          .bind(nextCursor, message.slice(0, 500), account.id)
          .run();
        idx = nextCursor;
        continue;
      }

      const startedAt = nowSec();
      const reportAt = startedAt + Math.max(1, Math.round(durationS));
      const gap = nextGapSec();
      await env.DB.prepare(
        `UPDATE netease_accounts
         SET status = 'active', last_listen_at = ?, last_error = NULL, listen_cursor = ?,
             pending_song_id = ?, pending_song_name = ?, pending_artist = ?,
             pending_duration = ?, pending_source_id = ?,
             report_at = ?, listening_until = ?, next_listen_at = ?
         WHERE id = ?`,
      )
        .bind(
          startedAt,
          nextCursor,
          track.songId,
          track.name,
          track.artist,
          Math.round(durationS),
          playlistId,
          reportAt,
          reportAt,
          reportAt + gap,
          account.id,
        )
        .run();
      await env.DB.prepare("UPDATE playlist_meta SET cursor = ?, updated_at = ? WHERE id = 1")
        .bind(idx, startedAt)
        .run();
      listenLog(
        "start.ok",
        `${who(account)} duration=${Math.round(durationS)}s reportAt=${new Date(reportAt * 1000).toISOString()} gap=${gap}s`,
      );
      return { started: 1, fail: 0 };
    } catch (e) {
      const expired = e instanceof CookieExpiredError;
      const message = e instanceof Error ? e.message : String(e);
      await writeLog(env, account, track, 0, message);
      if (expired) {
        listenLog("start.fail", `${who(account)} expired=true ${message}`);
        await markAccountError(env, account.id, true, message, 0, nextCursor);
        return { started: 0, fail: 1 };
      }
      listenLog("start.fail", `${who(account)} expired=false ${message} 跳到下一首 next=${nextCursor}`);
      await env.DB.prepare("UPDATE netease_accounts SET listen_cursor = ?, last_error = ? WHERE id = ?")
        .bind(nextCursor, message.slice(0, 500), account.id)
        .run();
      idx = nextCursor;
    }
  }

  await markAccountError(env, account.id, false, "连续几首无法开听，稍后再试", nowSec() + nextGapSec(), idx);
  return { started: 0, fail: 1 };
}

async function startDueAccounts(
  env: Env,
  playlistId: string,
  trackCount: number,
  deadline: number,
): Promise<{ started: number; fail: number; leftover: number }> {
  const now = nowSec();
  await env.DB.prepare(
    `UPDATE netease_accounts
     SET next_listen_at = ? + (ABS(RANDOM()) % ?)
     WHERE status = 'active' AND pending_song_id IS NULL AND listening_until <= ? AND next_listen_at = 0`,
  )
    .bind(now, SCATTER_MAX_SEC, now)
    .run();

  const dueRow = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM netease_accounts
     WHERE status = 'active' AND pending_song_id IS NULL AND listening_until <= ? AND next_listen_at > 0 AND next_listen_at <= ?`,
  )
    .bind(now, now)
    .first<{ n: number }>();
  const dueCount = Number(dueRow?.n || 0);

  const { results } = await env.DB.prepare(
    `SELECT id, user_id, cookie_enc, nickname, listen_cursor
     FROM netease_accounts
     WHERE status = 'active' AND pending_song_id IS NULL AND listening_until <= ? AND next_listen_at > 0 AND next_listen_at <= ?
     ORDER BY next_listen_at ASC
     LIMIT ?`,
  )
    .bind(now, now, MAX_STARTS_PER_TICK)
    .all<AccountRow>();

  listenLog("start.due", `count=${results?.length || 0} total=${dueCount} trackCount=${trackCount}`);
  const { outcomes, leftover: budgetLeft } = await mapPool(
    results || [],
    (account) => startOneAccount(env, account, playlistId, trackCount, deadline),
    deadline,
  );
  let started = 0;
  let fail = 0;
  for (const row of outcomes) {
    started += row.started;
    fail += row.fail;
  }
  const leftover = budgetLeft + Math.max(0, dueCount - (results?.length || 0));
  return { started, fail, leftover };
}

export async function tickListen(env: Env): Promise<{
  skipped?: string;
  reported: number;
  started: number;
  success: number;
  fail: number;
  leftoverReports: number;
  leftoverStarts: number;
  wallMs: number;
}> {
  const t0 = Date.now();
  const deadline = t0 + TICK_BUDGET_MS;
  const empty = {
    reported: 0,
    started: 0,
    success: 0,
    fail: 0,
    leftoverReports: 0,
    leftoverStarts: 0,
    wallMs: 0,
  };

  const meta = await getPlaylistMeta(env);
  if (!meta) {
    listenLog("tick.skip", "尚未初始化");
    empty.wallMs = Date.now() - t0;
    await writeHeartbeat(env, { at: nowSec(), status: "ok", ...empty, message: "尚未初始化" });
    return { skipped: "尚未初始化", ...empty };
  }

  listenLog(
    "tick.begin",
    `enabled=${!!meta.listen_enabled} playlist=${meta.playlist_id || "-"} tracks=${meta.track_count || 0} budget=${TICK_BUDGET_MS}ms`,
  );

  let reports = { success: 0, fail: 0, leftover: 0 };
  let starts = { started: 0, fail: 0, leftover: 0 };
  let skipped: string | undefined;
  let status: CronHeartbeat["status"] = "ok";

  try {
    reports = await finishDueReports(env, deadline);

    if (!meta.listen_enabled) {
      skipped = "互助听歌已关闭（已结算进行中的上报）";
    } else if (!meta.playlist_id || !meta.track_count) {
      skipped = "尚未设置歌单";
    } else {
      const owner = newId();
      if (await acquireWorkOrSkip(env, owner, "tick")) {
        try {
          starts = await startDueAccounts(env, meta.playlist_id, meta.track_count, deadline);
        } finally {
          await releaseWork(env, owner);
          listenLog("work.release", `owner=${owner.slice(0, 8)} 进入等待或不忙`);
        }
      } else {
        status = "busy";
        skipped = "上一次开听还在跑";
        const now = nowSec();
        const dueRow = await env.DB.prepare(
          `SELECT COUNT(*) as n FROM netease_accounts
           WHERE status = 'active' AND pending_song_id IS NULL AND listening_until <= ? AND next_listen_at > 0 AND next_listen_at <= ?`,
        )
          .bind(now, now)
          .first<{ n: number }>();
        starts.leftover = Number(dueRow?.n || 0);
      }
    }

    if (shouldTrimLogs() && !overBudget(deadline)) {
      await trimLogs(env);
    }
  } catch (e) {
    status = "error";
    skipped = e instanceof Error ? e.message : String(e);
    listenLog("tick.fail", skipped);
  }

  const wallMs = Date.now() - t0;
  const result = {
    skipped,
    reported: reports.success + reports.fail,
    started: starts.started,
    success: reports.success,
    fail: reports.fail + starts.fail,
    leftoverReports: reports.leftover,
    leftoverStarts: starts.leftover,
    wallMs,
  };
  listenLog(
    "tick.done",
    `started=${result.started} reported=${result.reported} success=${result.success} fail=${result.fail} leftoverStarts=${result.leftoverStarts} leftoverReports=${result.leftoverReports} wallMs=${wallMs}${skipped ? ` skipped=${skipped}` : ""}`,
  );
  await writeHeartbeat(env, {
    at: nowSec(),
    status,
    wallMs,
    started: result.started,
    reported: result.reported,
    leftoverStarts: result.leftoverStarts,
    leftoverReports: result.leftoverReports,
    message: skipped,
  });
  return result;
}

export async function recordCronError(env: Env, message: string, wallMs: number): Promise<void> {
  await writeHeartbeat(env, {
    at: nowSec(),
    status: "error",
    wallMs,
    started: 0,
    reported: 0,
    leftoverStarts: 0,
    leftoverReports: 0,
    message,
  });
}

export async function kickListen(env: Env): Promise<{
  skipped?: string;
  scattered: number;
  reported: number;
  started: number;
  success: number;
  fail: number;
  leftoverReports: number;
  leftoverStarts: number;
  wallMs: number;
}> {
  const scattered = await scatterIdleAccounts(env, 1);
  listenLog("kick", `scattered=${scattered}`);
  const tick = await tickListen(env);
  return { ...tick, scattered };
}
