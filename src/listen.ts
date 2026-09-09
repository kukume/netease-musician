import { decryptText, newId, nowSec } from "./crypto";
import {
  CookieExpiredError,
  fetchPublicPlaylist,
  finishPlaySession,
  MIN_REPORT_SECONDS,
  parsePlaylistId,
  startPlaySession,
  type PlaylistTrack,
} from "./netease";

const CLAIM_SECONDS = 12 * 60;
const MAX_STARTS_PER_TICK = 6;
const MAX_REPORTS_PER_TICK = 40;
const GAP_MIN_SEC = 40;
const GAP_MAX_SEC = 180;
const SCATTER_MAX_SEC = 240;
const WORK_LOCK_KEY = "listen_work";
const WORK_LOCK_IDLE = '{"owner":"","phase":"idle","refs":0,"expiresAt":0}';
const WORK_LOCK_TTL_SEC = 10 * 60;
const WORK_WAIT_MAX_MS = 10 * 60 * 1000;
const WORK_POLL_MS = 2_000;

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

async function sleep(ms: number): Promise<void> {
  const sched = (globalThis as unknown as { scheduler?: { wait(delay: number): Promise<void> } }).scheduler;
  let left = ms;
  while (left > 0) {
    const step = Math.min(left, 25_000);
    if (sched?.wait) await sched.wait(step);
    else await new Promise((resolve) => setTimeout(resolve, step));
    left -= step;
  }
}

type WorkPhase = "tick" | "report";

type WorkLock = {
  owner: string;
  phase: string;
  refs: number;
  expiresAt: number;
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
      refs: Number(value.refs || 0),
      expiresAt: Number(value.expiresAt || 0),
    };
  } catch {
    return { owner: "", phase: "idle", refs: 0, expiresAt: 0 };
  }
}

async function tryAcquireWork(env: Env, owner: string, phase: WorkPhase): Promise<boolean> {
  await ensureWorkLockRow(env);
  const now = nowSec();
  const expires = now + WORK_LOCK_TTL_SEC;
  const result = await env.DB.prepare(
    `UPDATE site_settings
     SET value = json_object(
       'owner', ?,
       'phase', ?,
       'refs', CASE
         WHEN coalesce(json_extract(value, '$.owner'), '') = ? AND coalesce(json_extract(value, '$.refs'), 0) > 0
         THEN coalesce(json_extract(value, '$.refs'), 0) + 1
         ELSE 1
       END,
       'expiresAt', ?
     )
     WHERE key = ?
     AND (
       coalesce(json_extract(value, '$.refs'), 0) <= 0
       OR coalesce(json_extract(value, '$.expiresAt'), 0) <= ?
       OR coalesce(json_extract(value, '$.owner'), '') = ?
     )`,
  )
    .bind(owner, phase, owner, expires, WORK_LOCK_KEY, now, owner)
    .run();
  return Number(result.meta.changes || 0) > 0;
}

async function releaseWork(env: Env, owner: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE site_settings
     SET value = CASE
       WHEN coalesce(json_extract(value, '$.refs'), 0) <= 1 THEN ?
       ELSE json_object(
         'owner', json_extract(value, '$.owner'),
         'phase', json_extract(value, '$.phase'),
         'refs', coalesce(json_extract(value, '$.refs'), 1) - 1,
         'expiresAt', json_extract(value, '$.expiresAt')
       )
     END
     WHERE key = ? AND coalesce(json_extract(value, '$.owner'), '') = ?`,
  )
    .bind(WORK_LOCK_IDLE, WORK_LOCK_KEY, owner)
    .run();
}

async function waitAndAcquireWork(env: Env, owner: string, phase: WorkPhase): Promise<void> {
  const started = Date.now();
  let waiting = false;
  while (!(await tryAcquireWork(env, owner, phase))) {
    if (Date.now() - started >= WORK_WAIT_MAX_MS) {
      listenLog("work.steal", `owner=${owner.slice(0, 8)} phase=${phase} waited=${Math.round(WORK_WAIT_MAX_MS / 1000)}s`);
      await env.DB.prepare("UPDATE site_settings SET value = ? WHERE key = ?").bind(WORK_LOCK_IDLE, WORK_LOCK_KEY).run();
      if (await tryAcquireWork(env, owner, phase)) return;
      throw new Error("听歌工作锁等待超时");
    }
    const lock = await readWorkLock(env);
    if (!waiting) {
      listenLog("work.wait", `busy=${lock.phase || "unknown"} 上一次还在下载或上报，卡住等待`);
      waiting = true;
    }
    await sleep(WORK_POLL_MS);
  }
  listenLog(
    waiting ? "work.acquired" : "work.hold",
    `owner=${owner.slice(0, 8)} phase=${phase}${waiting ? ` waited=${Math.round((Date.now() - started) / 1000)}s` : ""}`,
  );
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

async function markAccountError(env: Env, accountId: string, expired: boolean, message: string, nextListenAt: number) {
  await env.DB.prepare(
    `UPDATE netease_accounts
     SET status = ?, last_listen_at = ?, last_error = ?,
         listening_until = 0, report_at = 0,
         pending_song_id = NULL, pending_song_name = NULL, pending_artist = NULL,
         pending_duration = 0, pending_source_id = NULL,
         next_listen_at = ?
     WHERE id = ?`,
  )
    .bind(expired ? "expired" : "active", nowSec(), message.slice(0, 500), expired ? 0 : nextListenAt, accountId)
    .run();
}

async function reportOne(env: Env, accountId: string): Promise<"ok" | "fail" | "skip"> {
  const now = nowSec();
  const claimed = await env.DB.prepare(
    `UPDATE netease_accounts
     SET listening_until = 0
     WHERE id = ? AND status = 'active' AND pending_song_id IS NOT NULL AND report_at > 0 AND report_at <= ? AND listening_until > 0`,
  )
    .bind(accountId, now)
    .run();
  if (claimed.meta.changes === 0) {
    listenLog("report.skip", `id=${accountId.slice(0, 8)} 未到期或已上报`);
    return "skip";
  }

  const account = await env.DB.prepare(
    `SELECT id, user_id, cookie_enc, nickname, pending_song_id, pending_song_name, pending_artist,
            pending_duration, pending_source_id
     FROM netease_accounts WHERE id = ?`,
  )
    .bind(accountId)
    .first<AccountRow>();
  if (!account?.pending_song_id) {
    listenLog("report.skip", `id=${accountId.slice(0, 8)} 没有待上报歌曲`);
    return "skip";
  }

  const song = {
    songId: account.pending_song_id || "",
    name: account.pending_song_name || "未知歌曲",
    artist: account.pending_artist || "",
  };
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
      .bind(now, result.ok ? null : result.message.slice(0, 500), now + nextGapSec(), account.id)
      .run();
    return result.ok ? "ok" : "fail";
  } catch (e) {
    const expired = e instanceof CookieExpiredError;
    const message = e instanceof Error ? e.message : String(e);
    listenLog("report.fail", `${who(account)} expired=${expired} ${message}`);
    await writeLog(env, account, song, 0, message);
    await markAccountError(env, account.id, expired, message, now + nextGapSec());
    return "fail";
  }
}

function schedulePlayReport(
  env: Env,
  ctx: ExecutionContext | undefined,
  account: { id: string; nickname?: string | null },
  reportAt: number,
  owner: string,
) {
  const waitMs = Math.max(0, reportAt * 1000 - Date.now());
  listenLog("wait.play", `${who(account)} 模拟听歌 ${Math.round(waitMs / 1000)}s，到点后会打 report.start / weblog.play`);
  const run = async () => {
    try {
      await sleep(waitMs);
      listenLog("wait.play.due", `${who(account)} 等待结束，开始上报 play`);
      await waitAndAcquireWork(env, owner, "report");
      try {
        await reportOne(env, account.id);
      } finally {
        await releaseWork(env, owner);
      }
    } catch (e) {
      listenLog("wait.play.fail", `${who(account)} ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (ctx) ctx.waitUntil(run());
  else void run();
}

async function finishDueReports(env: Env): Promise<{ success: number; fail: number }> {
  const now = nowSec();
  const { results } = await env.DB.prepare(
    `SELECT id, nickname FROM netease_accounts
     WHERE pending_song_id IS NOT NULL AND report_at > 0 AND report_at <= ? AND status = 'active'
     LIMIT ?`,
  )
    .bind(now, MAX_REPORTS_PER_TICK)
    .all<{ id: string; nickname: string | null }>();

  listenLog("report.due", `count=${results?.length || 0}`);
  let success = 0;
  let fail = 0;
  for (const row of results || []) {
    const outcome = await reportOne(env, row.id);
    if (outcome === "ok") success += 1;
    else if (outcome === "fail") fail += 1;
  }
  return { success, fail };
}

async function startDueAccounts(
  env: Env,
  playlistId: string,
  trackCount: number,
  ctx?: ExecutionContext,
  owner?: string,
): Promise<{ started: number; fail: number }> {
  const now = nowSec();
  await env.DB.prepare(
    `UPDATE netease_accounts
     SET next_listen_at = ? + (ABS(RANDOM()) % ?)
     WHERE status = 'active' AND pending_song_id IS NULL AND listening_until <= ? AND next_listen_at = 0`,
  )
    .bind(now, SCATTER_MAX_SEC, now)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT id, user_id, cookie_enc, nickname, listen_cursor
     FROM netease_accounts
     WHERE status = 'active' AND pending_song_id IS NULL AND listening_until <= ? AND next_listen_at > 0 AND next_listen_at <= ?
     ORDER BY next_listen_at ASC
     LIMIT ?`,
  )
    .bind(now, now, MAX_STARTS_PER_TICK)
    .all<AccountRow>();

  listenLog("start.due", `count=${results?.length || 0} trackCount=${trackCount}`);
  let started = 0;
  let fail = 0;
  for (const account of results || []) {
    const claimed = await env.DB.prepare(
      `UPDATE netease_accounts
       SET listening_until = ?
       WHERE id = ? AND status = 'active' AND pending_song_id IS NULL AND listening_until <= ?`,
    )
      .bind(now + CLAIM_SECONDS, account.id, now)
      .run();
    if (claimed.meta.changes === 0) {
      listenLog("start.skip", `${who(account)} 未抢到锁（同时只听一首）`);
      continue;
    }

    const idx = Number(account.listen_cursor || 0) % Math.max(trackCount, 1);
    const track = await env.DB.prepare(
      "SELECT song_id as songId, name, artist, album, duration, cover FROM playlist_tracks WHERE idx = ?",
    )
      .bind(idx)
      .first<PlaylistTrack>();
    if (!track) {
      fail += 1;
      listenLog("start.fail", `${who(account)} idx=${idx} 歌单没有对应歌曲`);
      await markAccountError(env, account.id, false, "歌单没有对应歌曲", now + nextGapSec());
      continue;
    }

    listenLog("start.begin", `${who(account)} idx=${idx} song=${track.songId} ${track.name} / ${track.artist}`);
    try {
      const cookie = await decryptText(env.SESSION_SECRET, account.cookie_enc);
      const { durationS } = await startPlaySession(cookie, track.songId, {
        fallbackDurationMs: track.duration,
      });
      const nextCursor = (idx + 1) % trackCount;
      if (durationS <= MIN_REPORT_SECONDS) {
        const message = `歌曲过短，未上报 play（需 > ${MIN_REPORT_SECONDS}s）`;
        fail += 1;
        listenLog("start.skip-short", `${who(account)} duration=${durationS}s`);
        await writeLog(env, account, track, 0, message);
        await env.DB.prepare(
          `UPDATE netease_accounts
           SET status = 'active', last_listen_at = ?, last_error = ?, listen_cursor = ?,
               listening_until = 0, report_at = 0,
               pending_song_id = NULL, pending_song_name = NULL, pending_artist = NULL,
               pending_duration = 0, pending_source_id = NULL,
               next_listen_at = ?
           WHERE id = ?`,
        )
          .bind(now, message, nextCursor, now + nextGapSec(), account.id)
          .run();
        continue;
      }

      const reportAt = now + Math.max(1, Math.round(durationS));
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
          now,
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
        .bind(idx, now)
        .run();
      started += 1;
      listenLog(
        "start.ok",
        `${who(account)} duration=${Math.round(durationS)}s reportAt=${new Date(reportAt * 1000).toISOString()} gap=${gap}s`,
      );
      schedulePlayReport(env, ctx, account, reportAt, owner || newId());
    } catch (e) {
      fail += 1;
      const expired = e instanceof CookieExpiredError;
      const message = e instanceof Error ? e.message : String(e);
      listenLog("start.fail", `${who(account)} expired=${expired} ${message}`);
      await writeLog(env, account, track, 0, message);
      await markAccountError(env, account.id, expired, message, now + nextGapSec());
    }
  }
  return { started, fail };
}

export async function tickListen(env: Env, ctx?: ExecutionContext): Promise<{
  skipped?: string;
  reported: number;
  started: number;
  success: number;
  fail: number;
}> {
  const meta = await getPlaylistMeta(env);
  if (!meta) {
    listenLog("tick.skip", "尚未初始化");
    return { skipped: "尚未初始化", reported: 0, started: 0, success: 0, fail: 0 };
  }

  const owner = newId();
  await waitAndAcquireWork(env, owner, "tick");
  try {
    listenLog(
      "tick.begin",
      `enabled=${!!meta.listen_enabled} playlist=${meta.playlist_id || "-"} tracks=${meta.track_count || 0}`,
    );
    const reports = await finishDueReports(env);
    if (!meta.listen_enabled) {
      await trimLogs(env);
      listenLog("tick.done", `听歌已关闭 reported=${reports.success + reports.fail} success=${reports.success} fail=${reports.fail}`);
      return {
        skipped: "互助听歌已关闭（已结算进行中的上报）",
        reported: reports.success + reports.fail,
        started: 0,
        success: reports.success,
        fail: reports.fail,
      };
    }
    if (!meta.playlist_id || !meta.track_count) {
      await trimLogs(env);
      listenLog("tick.skip", "尚未设置歌单");
      return { skipped: "尚未设置歌单", reported: reports.success + reports.fail, started: 0, success: reports.success, fail: reports.fail };
    }

    const starts = await startDueAccounts(env, meta.playlist_id, meta.track_count, ctx, owner);
    await trimLogs(env);
    listenLog(
      "tick.done",
      `started=${starts.started} reported=${reports.success + reports.fail} success=${reports.success} fail=${reports.fail + starts.fail}`,
    );
    return {
      reported: reports.success + reports.fail,
      started: starts.started,
      success: reports.success,
      fail: reports.fail + starts.fail,
    };
  } finally {
    await releaseWork(env, owner);
    listenLog("work.release", `owner=${owner.slice(0, 8)} 进入等待或不忙`);
  }
}

export async function kickListen(env: Env, ctx?: ExecutionContext): Promise<{
  skipped?: string;
  scattered: number;
  reported: number;
  started: number;
  success: number;
  fail: number;
}> {
  const scattered = await scatterIdleAccounts(env, 1);
  listenLog("kick", `scattered=${scattered}`);
  const tick = await tickListen(env, ctx);
  return { ...tick, scattered };
}
