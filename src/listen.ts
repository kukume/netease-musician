import { decryptText, newId, nowSec } from "./crypto";
import { sendCookieExpiredEmail } from "./email";
import {
  assertCookieValid,
  CookieExpiredError,
  fetchPlayAudio,
  fetchPlaylistCreator,
  fetchPublicPlaylist,
  fetchUserArtistId,
  finishPlaySession,
  MIN_REPORT_SECONDS,
  parsePlaylistId,
  startPlaySession,
  type PlaylistTrack,
} from "./netease";

const CLAIM_SECONDS = 90;
const MAX_SONG_TRIES = 3;
const START_BUDGET_MS = 50_000;
const REPORT_STALE_SEC = 10 * 60;
const CRON_HEALTHY_SEC = 720;
const GAP_MIN_SEC = 40;
const GAP_MAX_SEC = 180;
const BIND_START_MIN_SEC = 20;
const BIND_START_MAX_SEC = 180;
const REPORT_TAIL_MIN_SEC = 3;
const REPORT_TAIL_MAX_SEC = 12;
const REPAIR_GRACE_SEC = 180;
const REPAIR_SCATTER_MAX_SEC = 120;
const KICK_SCATTER_MAX_SEC = 30;
const MAX_REPAIR_PER_TICK = 40;
const HEARTBEAT_KEY = "listen_cron";

export type WakeKind = "start" | "report";

export type ListenQueueMessage = {
  type: WakeKind | "audio";
  accountId: string;
  token?: string;
  songId?: string;
  playUrl?: string;
};

type QueueAction = "ack" | "retry";

type AccountRow = {
  id: string;
  user_id: string;
  cookie_enc: string;
  nickname: string | null;
  status: string;
  listen_cursor: number;
  artist_id?: string | null;
  pending_song_id: string | null;
  pending_song_name: string | null;
  pending_artist: string | null;
  pending_duration: number;
  pending_source_id: string | null;
  report_at: number;
  listening_until: number;
  next_listen_at: number;
  wake_kind: string | null;
  wake_at: number;
  wake_token: string | null;
};

function randInt(min: number, max: number): number {
  const span = max - min + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % span);
}

function nextGapSec(): number {
  return randInt(GAP_MIN_SEC, GAP_MAX_SEC);
}

function bindStartDelaySec(): number {
  return randInt(BIND_START_MIN_SEC, BIND_START_MAX_SEC);
}

function reportDelaySec(durationS: number): number {
  return Math.max(1, Math.round(durationS)) + randInt(REPORT_TAIL_MIN_SEC, REPORT_TAIL_MAX_SEC);
}

function clampDelay(sec: number): number {
  return Math.max(0, Math.min(86400, Math.round(sec)));
}

function listenLog(step: string, detail?: string) {
  console.log(detail ? `[listen] ${step} ${detail}` : `[listen] ${step}`);
}

function who(account: { id: string; nickname?: string | null }) {
  return `account="${account.nickname || "未命名"}" id=${account.id.slice(0, 8)}`;
}

function isListenAudioEnabled(env: Env): boolean {
  const raw = (env.LISTEN_AUDIO_ENABLED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function parseArtistIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((id) => String(id)).filter(Boolean);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map((id) => String(id)).filter(Boolean) : [];
  } catch {
    return raw.split(",").map((id) => id.trim()).filter(Boolean);
  }
}

function isOwnTrack(artistIds: string[], ids: string[]): boolean {
  const mine = new Set(ids.filter(Boolean));
  return artistIds.some((id) => mine.has(id));
}

function overBudget(deadline: number): boolean {
  return Date.now() >= deadline;
}

function hasValidWake(row: { wake_token?: string | null; wake_at?: number | null; wake_kind?: string | null }, now = nowSec()): boolean {
  const kind = row.wake_kind === "start" || row.wake_kind === "report" ? row.wake_kind : "";
  return Boolean(row.wake_token && kind && Number(row.wake_at || 0) > now);
}

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

async function loadAccount(env: Env, accountId: string): Promise<AccountRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, cookie_enc, nickname, status, listen_cursor, artist_id,
            pending_song_id, pending_song_name, pending_artist, pending_duration, pending_source_id,
            report_at, listening_until, next_listen_at, wake_kind, wake_at, wake_token
     FROM netease_accounts WHERE id = ?`,
  )
    .bind(accountId)
    .first<AccountRow>();
}

async function sendWake(env: Env, kind: WakeKind, body: ListenQueueMessage, delaySeconds: number): Promise<void> {
  const queue = kind === "start" ? env.LISTEN_START : env.LISTEN_REPORT;
  await queue.send(body, { delaySeconds });
}

async function sendAudioFetch(env: Env, accountId: string, songId: string, playUrl: string): Promise<void> {
  if (!isListenAudioEnabled(env)) return;
  await env.LISTEN_AUDIO.send({ type: "audio", accountId, songId, playUrl }, { delaySeconds: 0 });
}

async function scheduleWake(
  env: Env,
  accountId: string,
  kind: WakeKind,
  delaySec: number,
  extra?: { songId?: string },
): Promise<void> {
  const token = newId();
  const delay = clampDelay(delaySec);
  const wakeAt = nowSec() + delay;
  const nextListenAt = kind === "start" ? wakeAt : undefined;
  if (nextListenAt != null) {
    await env.DB.prepare(
      `UPDATE netease_accounts SET wake_kind = ?, wake_at = ?, wake_token = ?, next_listen_at = ? WHERE id = ?`,
    )
      .bind(kind, wakeAt, token, nextListenAt, accountId)
      .run();
  } else {
    await env.DB.prepare(`UPDATE netease_accounts SET wake_kind = ?, wake_at = ?, wake_token = ? WHERE id = ?`)
      .bind(kind, wakeAt, token, accountId)
      .run();
  }
  const body: ListenQueueMessage = { type: kind, accountId, token };
  if (extra?.songId) body.songId = extra.songId;
  try {
    await sendWake(env, kind, body, delay);
    listenLog("wake.send", `kind=${kind} id=${accountId.slice(0, 8)} delay=${delay}s token=${token.slice(0, 8)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    listenLog("wake.send-fail", `kind=${kind} id=${accountId.slice(0, 8)} ${message}`);
  }
}

export async function onAccountBound(
  env: Env,
  account: {
    id: string;
    isNew: boolean;
    pendingSongId?: string | null;
    wakeAt?: number | null;
    wakeKind?: string | null;
    wakeToken?: string | null;
  },
): Promise<void> {
  if (!account.isNew && account.pendingSongId) {
    listenLog("bind.keep", `id=${account.id.slice(0, 8)} 正在听，只更新资料`);
    return;
  }
  if (!account.isNew && hasValidWake({ wake_token: account.wakeToken, wake_at: account.wakeAt, wake_kind: account.wakeKind })) {
    listenLog("bind.keep", `id=${account.id.slice(0, 8)} 闹钟仍有效，不重新入队`);
    return;
  }
  await scheduleWake(env, account.id, "start", bindStartDelaySec());
}

async function notifyCookieExpired(env: Env, accountId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT a.status as status, a.nickname as nickname, u.email as email
     FROM netease_accounts a JOIN users u ON u.id = a.user_id
     WHERE a.id = ?`,
  )
    .bind(accountId)
    .first<{ status: string; nickname: string | null; email: string | null }>();
  if (!row || row.status === "expired" || !row.email) return;
  try {
    await sendCookieExpiredEmail(env, row.email, row.nickname || "");
    listenLog("email.expire.ok", `id=${accountId.slice(0, 8)} to=${row.email}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    listenLog("email.expire.fail", `id=${accountId.slice(0, 8)} ${message}`);
  }
}

async function clearPending(
  env: Env,
  accountId: string,
  opts: { expired: boolean; message: string; nextListenAt?: number; listenCursor?: number },
): Promise<void> {
  if (opts.expired) await notifyCookieExpired(env, accountId);
  await env.DB.prepare(
    `UPDATE netease_accounts
     SET status = ?, last_listen_at = ?, last_error = ?,
         listening_until = 0, report_at = 0,
         pending_song_id = NULL, pending_song_name = NULL, pending_artist = NULL,
         pending_duration = 0, pending_source_id = NULL,
         next_listen_at = ?, wake_kind = NULL, wake_at = 0, wake_token = NULL
         ${opts.listenCursor != null ? ", listen_cursor = ?" : ""}
     WHERE id = ?`,
  )
    .bind(
      opts.expired ? "expired" : "active",
      nowSec(),
      opts.message.slice(0, 500),
      opts.expired ? 0 : opts.nextListenAt || 0,
      ...(opts.listenCursor != null ? [opts.listenCursor] : []),
      accountId,
    )
    .run();
}

export async function savePlaylist(env: Env, input: string): Promise<{ name: string; cover: string; trackCount: number }> {
  const playlistId = parsePlaylistId(input);
  const info = await fetchPublicPlaylist(playlistId);
  if (!info.tracks.length) throw new Error("歌单为空或无法读取歌曲");

  await env.DB.prepare("DELETE FROM playlist_tracks").run();
  await env.DB.prepare(
    `UPDATE playlist_meta
     SET playlist_id = ?, name = ?, cover = ?, track_count = ?, creator_id = ?, cursor = 0, updated_at = ?
     WHERE id = 1`,
  )
    .bind(info.playlistId, info.name, info.cover, info.tracks.length, info.creatorId, nowSec())
    .run();

  for (let i = 0; i < info.tracks.length; i += 40) {
    const chunk = info.tracks.slice(i, i + 40).map((t, offset) =>
      env.DB.prepare(
        "INSERT INTO playlist_tracks (idx, song_id, name, artist, album, duration, cover, artist_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(i + offset, t.songId, t.name, t.artist, t.album, t.duration, t.cover, JSON.stringify(t.artistIds || [])),
    );
    await env.DB.batch(chunk);
  }

  await env.DB.prepare(`UPDATE netease_accounts SET listen_cursor = 0 WHERE status = 'active'`).run();
  return { name: info.name, cover: info.cover, trackCount: info.tracks.length };
}

export async function getPlaylistMeta(env: Env) {
  return env.DB.prepare("SELECT * FROM playlist_meta WHERE id = 1").first<{
    playlist_id: string;
    name: string | null;
    cover: string | null;
    track_count: number;
    creator_id?: string;
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

async function resolveCreatorId(env: Env, cookie: string, playlistId: string, stored?: string): Promise<string> {
  if (stored) return stored;
  if (!playlistId) return "";
  try {
    const creatorId = await fetchPlaylistCreator(cookie, playlistId);
    if (creatorId) {
      await env.DB.prepare("UPDATE playlist_meta SET creator_id = ? WHERE id = 1").bind(creatorId).run();
      listenLog("playlist.creator", `id=${playlistId} creator=${creatorId}`);
    }
    return creatorId;
  } catch (e) {
    listenLog("playlist.creator.fail", `${playlistId} ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

async function startOneAccount(
  env: Env,
  account: AccountRow,
  playlistId: string,
  trackCount: number,
  creatorId?: string,
): Promise<"started" | "locked" | "expired" | "fail"> {
  const claimed = await env.DB.prepare(
    `UPDATE netease_accounts
     SET listening_until = ?
     WHERE id = ? AND status = 'active' AND pending_song_id IS NULL AND listening_until <= ? AND wake_token = ?`,
  )
    .bind(nowSec() + CLAIM_SECONDS, account.id, nowSec(), account.wake_token)
    .run();
  if (claimed.meta.changes === 0) {
    listenLog("start.skip", `${who(account)} 未抢到锁`);
    return "locked";
  }

  const n = Math.max(trackCount, 1);
  let idx = Number(account.listen_cursor || 0) % n;
  const deadline = Date.now() + START_BUDGET_MS;

  let cookie: string;
  let uid = "";
  try {
    cookie = await decryptText(env.SESSION_SECRET, account.cookie_enc);
    const me = await assertCookieValid(cookie);
    uid = me.uid;
    listenLog("cookie.ok", `${who(account)} uid=${me.uid} nickname="${me.nickname}"`);
  } catch (e) {
    const expired = e instanceof CookieExpiredError;
    const message = e instanceof Error ? e.message : String(e);
    listenLog("start.fail", `${who(account)} expired=${expired} ${expired ? "个人资料接口判定登录失效" : message}`);
    await clearPending(env, account.id, { expired, message, listenCursor: idx });
    if (expired) return "expired";
    await scheduleWake(env, account.id, "start", nextGapSec());
    return "fail";
  }

  const resolvedCreatorId = await resolveCreatorId(env, cookie, playlistId, creatorId);

  let artistId = String(account.artist_id || "");
  if (!artistId) {
    artistId = await fetchUserArtistId(cookie, uid);
    if (artistId) {
      await env.DB.prepare("UPDATE netease_accounts SET artist_id = ? WHERE id = ?").bind(artistId, account.id).run();
      listenLog("artist.ok", `${who(account)} uid=${uid} artistId=${artistId}`);
    }
  }

  let playFails = 0;
  let scanned = 0;
  let ownSkipped = 0;
  while (scanned < n && playFails < MAX_SONG_TRIES) {
    if (overBudget(deadline)) {
      await env.DB.prepare(`UPDATE netease_accounts SET listening_until = 0, listen_cursor = ? WHERE id = ?`)
        .bind(idx, account.id)
        .run();
      await scheduleWake(env, account.id, "start", 8);
      listenLog("start.defer", `${who(account)} 本轮超时，游标=${idx} 稍后重试`);
      return "started";
    }

    scanned += 1;
    const nextCursor = (idx + 1) % n;
    const track = await env.DB.prepare(
      "SELECT song_id as songId, name, artist, album, duration, cover, artist_ids as artistIds FROM playlist_tracks WHERE idx = ?",
    )
      .bind(idx)
      .first<PlaylistTrack & { artistIds?: string | string[] }>();
    if (!track) {
      listenLog("start.fail", `${who(account)} idx=${idx} 歌单没有对应歌曲，跳到下一首 next=${nextCursor}`);
      await env.DB.prepare("UPDATE netease_accounts SET listen_cursor = ? WHERE id = ?").bind(nextCursor, account.id).run();
      idx = nextCursor;
      playFails += 1;
      continue;
    }

    const artistIds = parseArtistIds(track.artistIds);
    if (isOwnTrack(artistIds, [uid, artistId])) {
      ownSkipped += 1;
      listenLog("start.skip-own", `${who(account)} idx=${idx} song=${track.songId} ${track.name} 是自己的歌，跳过 next=${nextCursor}`);
      await env.DB.prepare("UPDATE netease_accounts SET listen_cursor = ? WHERE id = ?").bind(nextCursor, account.id).run();
      idx = nextCursor;
      continue;
    }

    listenLog("start.begin", `${who(account)} idx=${idx} try=${playFails + 1}/${MAX_SONG_TRIES} song=${track.songId} ${track.name} / ${track.artist}`);
    try {
      const { durationS, playUrl } = await startPlaySession(cookie, track.songId, {
        fallbackDurationMs: track.duration,
        playlistId,
        creatorId: resolvedCreatorId,
      });
      if (durationS <= MIN_REPORT_SECONDS) {
        const message = `歌曲过短，未上报 play（需 > ${MIN_REPORT_SECONDS}s）`;
        listenLog("start.skip-short", `${who(account)} duration=${durationS}s 跳到下一首 next=${nextCursor}`);
        await writeLog(env, account, track, 0, message);
        await env.DB.prepare("UPDATE netease_accounts SET listen_cursor = ?, last_error = ? WHERE id = ?")
          .bind(nextCursor, message.slice(0, 500), account.id)
          .run();
        idx = nextCursor;
        playFails += 1;
        continue;
      }

      const token = newId();
      const startedAt = nowSec();
      const duration = Math.round(durationS);
      const reportAt = startedAt + Math.max(1, duration);
      const delay = reportDelaySec(duration);
      const wakeAt = startedAt + delay;
      await env.DB.prepare(
        `UPDATE netease_accounts
         SET status = 'active', last_listen_at = ?, last_error = NULL, listen_cursor = ?,
             pending_song_id = ?, pending_song_name = ?, pending_artist = ?,
             pending_duration = ?, pending_source_id = ?,
             report_at = ?, listening_until = 0,
             wake_kind = 'report', wake_at = ?, wake_token = ?
         WHERE id = ?`,
      )
        .bind(
          startedAt,
          nextCursor,
          track.songId,
          track.name,
          track.artist,
          duration,
          playlistId,
          reportAt,
          wakeAt,
          token,
          account.id,
        )
        .run();
      await env.DB.prepare("UPDATE playlist_meta SET cursor = ?, updated_at = ? WHERE id = 1")
        .bind(idx, startedAt)
        .run();
      if (isListenAudioEnabled(env)) {
        try {
          await sendAudioFetch(env, account.id, track.songId, playUrl);
          listenLog("audio.enqueue", `${who(account)} song=${track.songId}`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          listenLog("audio.enqueue-fail", `${who(account)} ${message}`);
        }
      }
      try {
        await sendWake(
          env,
          "report",
          { type: "report", accountId: account.id, token, songId: track.songId },
          delay,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        listenLog("wake.send-fail", `${who(account)} report ${message}`);
      }
      listenLog(
        "start.ok",
        `${who(account)} duration=${duration}s reportAt=${new Date(reportAt * 1000).toISOString()} delay=${delay}s`,
      );
      return "started";
    } catch (e) {
      const expired = e instanceof CookieExpiredError;
      const message = e instanceof Error ? e.message : String(e);
      await writeLog(env, account, track, 0, message);
      if (expired) {
        listenLog("start.fail", `${who(account)} expired=true ${message}`);
        await clearPending(env, account.id, { expired: true, message, listenCursor: nextCursor });
        return "expired";
      }
      listenLog("start.fail", `${who(account)} expired=false ${message} 跳到下一首 next=${nextCursor}`);
      await env.DB.prepare("UPDATE netease_accounts SET listen_cursor = ?, last_error = ? WHERE id = ?")
        .bind(nextCursor, message.slice(0, 500), account.id)
        .run();
      idx = nextCursor;
      playFails += 1;
    }
  }

  const message = ownSkipped >= n ? "歌单里没有可听的他人歌曲" : "连续几首无法开听，稍后再试";
  await clearPending(env, account.id, { expired: false, message, listenCursor: idx });
  await scheduleWake(env, account.id, "start", nextGapSec());
  return "fail";
}

async function handleStart(env: Env, body: ListenQueueMessage): Promise<QueueAction> {
  const account = await loadAccount(env, body.accountId);
  if (!account) {
    listenLog("start.skip", `id=${body.accountId.slice(0, 8)} 账号已删除`);
    return "ack";
  }
  if (!body.token || account.wake_token !== body.token || account.wake_kind !== "start") {
    listenLog("start.stale", `${who(account)} 旧闹钟`);
    return "ack";
  }
  if (account.status !== "active") {
    listenLog("start.skip", `${who(account)} status=${account.status}`);
    return "ack";
  }
  if (account.pending_song_id) {
    listenLog("start.skip", `${who(account)} 已在听 ${account.pending_song_id}`);
    return "ack";
  }

  const meta = await getPlaylistMeta(env);
  if (!meta?.listen_enabled) {
    listenLog("start.paused", `${who(account)} 互助听歌已关闭`);
    return "ack";
  }
  if (!meta.playlist_id || !meta.track_count) {
    listenLog("start.skip", `${who(account)} 尚未设置歌单`);
    return "ack";
  }

  const result = await startOneAccount(env, account, meta.playlist_id, meta.track_count, meta.creator_id);
  if (result === "locked") {
    const again = await loadAccount(env, account.id);
    if (!again || again.wake_token !== body.token || again.pending_song_id) return "ack";
    return "retry";
  }
  return "ack";
}

async function handleReport(env: Env, body: ListenQueueMessage, attempts: number): Promise<QueueAction> {
  const account = await loadAccount(env, body.accountId);
  if (!account) {
    listenLog("report.skip", `id=${body.accountId.slice(0, 8)} 账号已删除`);
    return "ack";
  }
  if (!body.token || account.wake_token !== body.token || account.wake_kind !== "report") {
    listenLog("report.stale", `${who(account)} 旧闹钟`);
    return "ack";
  }
  if (account.status !== "active") {
    listenLog("report.skip", `${who(account)} status=${account.status}`);
    return "ack";
  }
  if (!account.pending_song_id) {
    listenLog("report.skip", `${who(account)} 没有待上报歌曲`);
    return "ack";
  }
  if (body.songId && body.songId !== account.pending_song_id) {
    listenLog("report.stale", `${who(account)} song=${body.songId} pending=${account.pending_song_id}`);
    return "ack";
  }

  const now = nowSec();
  if (Number(account.report_at || 0) > now) {
    listenLog("report.early", `${who(account)} in=${account.report_at - now}s`);
    return "retry";
  }

  const claimed = await env.DB.prepare(
    `UPDATE netease_accounts
     SET listening_until = ?
     WHERE id = ? AND status = 'active' AND pending_song_id IS NOT NULL AND report_at > 0 AND report_at <= ? AND listening_until <= ? AND wake_token = ?`,
  )
    .bind(now + CLAIM_SECONDS, account.id, now, now, body.token)
    .run();
  if (claimed.meta.changes === 0) {
    const again = await loadAccount(env, account.id);
    if (!again || again.wake_token !== body.token || !again.pending_song_id) return "ack";
    return "retry";
  }

  const song = {
    songId: account.pending_song_id || "",
    name: account.pending_song_name || "未知歌曲",
    artist: account.pending_artist || "",
  };

  const meta = await getPlaylistMeta(env);
  const listenEnabled = !!meta?.listen_enabled;

  if (Number(account.report_at || 0) <= now - REPORT_STALE_SEC) {
    const message = "上报过期，已跳过";
    listenLog("report.stale", `${who(account)} song=${song.songId} ${song.name}`);
    await writeLog(env, account, song, 0, message);
    await clearPending(env, account.id, { expired: false, message });
    if (listenEnabled) await scheduleWake(env, account.id, "start", nextGapSec());
    return "ack";
  }

  listenLog("report.start", `${who(account)} song=${song.songId} ${song.name} duration=${account.pending_duration}s`);
  try {
    const cookie = await decryptText(env.SESSION_SECRET, account.cookie_enc);
    const creatorId = await resolveCreatorId(
      env,
      cookie,
      account.pending_source_id || meta?.playlist_id || "",
      meta?.creator_id,
    );
    const result = await finishPlaySession(
      cookie,
      song.songId,
      Number(account.pending_duration || 0),
      account.pending_source_id || undefined,
      { creatorId },
    );
    listenLog("report.done", `${who(account)} ok=${result.ok} ${result.message}`);
    await writeLog(env, account, song, result.ok ? 1 : 0, result.message);
    const gap = nextGapSec();
    await env.DB.prepare(
      `UPDATE netease_accounts
       SET status = 'active', last_listen_at = ?, last_error = ?,
           listening_until = 0, report_at = 0,
           pending_song_id = NULL, pending_song_name = NULL, pending_artist = NULL,
           pending_duration = 0, pending_source_id = NULL
       WHERE id = ?`,
    )
      .bind(nowSec(), result.ok ? null : result.message.slice(0, 500), account.id)
      .run();
    if (listenEnabled) await scheduleWake(env, account.id, "start", gap);
    else {
      await env.DB.prepare(
        `UPDATE netease_accounts SET wake_kind = NULL, wake_at = 0, wake_token = NULL, next_listen_at = 0 WHERE id = ?`,
      )
        .bind(account.id)
        .run();
    }
    return "ack";
  } catch (e) {
    const expired = e instanceof CookieExpiredError;
    const message = e instanceof Error ? e.message : String(e);
    listenLog("report.fail", `${who(account)} expired=${expired} ${message}`);
    await writeLog(env, account, song, 0, message);
    if (expired) {
      await clearPending(env, account.id, { expired: true, message });
      return "ack";
    }
    if (attempts < 3) return "retry";
    await clearPending(env, account.id, { expired: false, message });
    if (listenEnabled) await scheduleWake(env, account.id, "start", nextGapSec());
    return "ack";
  }
}

async function handleAudio(body: ListenQueueMessage): Promise<void> {
  const playUrl = body.playUrl?.trim();
  if (!playUrl) {
    listenLog("audio.skip", `id=${body.accountId.slice(0, 8)} 没有播放地址`);
    return;
  }
  listenLog("audio.start", `id=${body.accountId.slice(0, 8)} song=${body.songId || "-"}`);
  try {
    const result = await fetchPlayAudio(playUrl);
    if (result.ok) {
      listenLog("audio.ok", `id=${body.accountId.slice(0, 8)} song=${body.songId || "-"} http=${result.status} bytes=${result.bytes}`);
      return;
    }
    listenLog("audio.fail", `id=${body.accountId.slice(0, 8)} song=${body.songId || "-"} http=${result.status} bytes=${result.bytes}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    listenLog("audio.fail", `id=${body.accountId.slice(0, 8)} song=${body.songId || "-"} ${message}`);
  }
}

function retryDelayFor(body: ListenQueueMessage, reportAt?: number): number {
  if (body.type === "report" && reportAt && reportAt > nowSec()) {
    return clampDelay(reportAt - nowSec() + 1);
  }
  return body.type === "report" ? 20 : 30;
}

function isAudioQueue(queueName: string): boolean {
  return queueName === "netease-musician-audio";
}

export async function handleListenQueue(env: Env, batch: MessageBatch<ListenQueueMessage>): Promise<void> {
  listenLog("queue.batch", `queue=${batch.queue} n=${batch.messages.length}`);
  const audioOnly = isAudioQueue(batch.queue);
  for (const msg of batch.messages) {
    const body = msg.body;
    const type = audioOnly ? "audio" : body?.type;
    const known = type === "start" || type === "report" || type === "audio";
    if (!body?.accountId || !known || (type !== "audio" && !body.token)) {
      listenLog("queue.bad", `id=${msg.id}`);
      msg.ack();
      continue;
    }
    if (type === "audio") {
      if (isListenAudioEnabled(env)) {
        try {
          await handleAudio(body);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          listenLog("queue.fail", `type=audio id=${body.accountId.slice(0, 8)} ${message}`);
        }
      } else {
        listenLog("audio.skip", `id=${body.accountId.slice(0, 8)} LISTEN_AUDIO_ENABLED 未开启`);
      }
      msg.ack();
      continue;
    }
    try {
      const action = type === "report" ? await handleReport(env, body, msg.attempts) : await handleStart(env, body);
      if (action === "retry") {
        const account = await loadAccount(env, body.accountId);
        msg.retry({ delaySeconds: retryDelayFor({ ...body, type }, account?.report_at) });
      } else {
        msg.ack();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      listenLog("queue.fail", `type=${type} id=${body.accountId.slice(0, 8)} ${message}`);
      msg.retry({ delaySeconds: type === "report" ? 20 : 45 });
    }
  }
}

type RepairRow = {
  id: string;
  pending_song_id: string | null;
  report_at: number;
};

async function repairStuckWakes(
  env: Env,
  opts: { graceSec: number; scatterMax: number; forceIdleStarts?: boolean },
): Promise<{ started: number; reported: number; leftoverStarts: number; leftoverReports: number; skipped?: string }> {
  const meta = await getPlaylistMeta(env);
  if (!meta) return { started: 0, reported: 0, leftoverStarts: 0, leftoverReports: 0, skipped: "尚未初始化" };

  const now = nowSec();
  const staleBefore = now - Math.max(0, opts.graceSec);
  const scatter = Math.max(1, opts.scatterMax);

  const dueReports = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM netease_accounts
     WHERE status = 'active' AND pending_song_id IS NOT NULL AND (wake_at = 0 OR wake_at < ?)`,
  )
    .bind(staleBefore)
    .first<{ n: number }>();

  let dueStarts = 0;
  if (meta.listen_enabled && meta.playlist_id && meta.track_count) {
    if (opts.forceIdleStarts) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM netease_accounts WHERE status = 'active' AND pending_song_id IS NULL`,
      ).first<{ n: number }>();
      dueStarts = Number(row?.n || 0);
    } else {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM netease_accounts
         WHERE status = 'active' AND pending_song_id IS NULL AND (wake_at = 0 OR wake_at < ?)`,
      )
        .bind(staleBefore)
        .first<{ n: number }>();
      dueStarts = Number(row?.n || 0);
    }
  }

  const { results: reportRows } = await env.DB.prepare(
    `SELECT id, pending_song_id, report_at FROM netease_accounts
     WHERE status = 'active' AND pending_song_id IS NOT NULL AND (wake_at = 0 OR wake_at < ?)
     ORDER BY wake_at ASC LIMIT ?`,
  )
    .bind(staleBefore, MAX_REPAIR_PER_TICK)
    .all<RepairRow>();

  let started = 0;
  let reported = 0;
  const startBudget = Math.max(0, MAX_REPAIR_PER_TICK - (reportRows?.length || 0));

  for (const row of reportRows || []) {
    const delay = randInt(0, scatter);
    if (Number(row.report_at || 0) > 0 && Number(row.report_at) <= now - REPORT_STALE_SEC) {
      await clearPending(env, row.id, { expired: false, message: "上报过期，已跳过" });
      if (meta.listen_enabled && meta.playlist_id) {
        await scheduleWake(env, row.id, "start", delay || bindStartDelaySec());
        started += 1;
      }
      continue;
    }
    await scheduleWake(env, row.id, "report", delay, { songId: row.pending_song_id || undefined });
    reported += 1;
  }

  if (meta.listen_enabled && meta.playlist_id && meta.track_count && startBudget > 0) {
    const startQuery = opts.forceIdleStarts
      ? `SELECT id, pending_song_id, report_at FROM netease_accounts
         WHERE status = 'active' AND pending_song_id IS NULL
         ORDER BY wake_at ASC LIMIT ?`
      : `SELECT id, pending_song_id, report_at FROM netease_accounts
         WHERE status = 'active' AND pending_song_id IS NULL AND (wake_at = 0 OR wake_at < ?)
         ORDER BY wake_at ASC LIMIT ?`;
    const stmt = env.DB.prepare(startQuery);
    const { results: startRows } = opts.forceIdleStarts
      ? await stmt.bind(startBudget).all<RepairRow>()
      : await stmt.bind(staleBefore, startBudget).all<RepairRow>();
    for (const row of startRows || []) {
      await scheduleWake(env, row.id, "start", randInt(0, scatter));
      started += 1;
    }
  }

  const leftoverReports = Math.max(0, Number(dueReports?.n || 0) - reported);
  const leftoverStarts = Math.max(0, dueStarts - started);
  let skipped: string | undefined;
  if (!meta.listen_enabled) skipped = "互助听歌已关闭（仍会补到期上报）";
  else if (!meta.playlist_id || !meta.track_count) skipped = "尚未设置歌单";
  listenLog(
    "repair.done",
    `started=${started} reported=${reported} leftoverStarts=${leftoverStarts} leftoverReports=${leftoverReports}${skipped ? ` skipped=${skipped}` : ""}`,
  );
  return { started, reported, leftoverStarts, leftoverReports, skipped };
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
  const empty = {
    reported: 0,
    started: 0,
    success: 0,
    fail: 0,
    leftoverReports: 0,
    leftoverStarts: 0,
    wallMs: 0,
  };

  listenLog("tick.begin", `repair grace=${REPAIR_GRACE_SEC}s scatter=${REPAIR_SCATTER_MAX_SEC}s`);
  let status: CronHeartbeat["status"] = "ok";
  let result = { ...empty, skipped: undefined as string | undefined };

  try {
    const repair = await repairStuckWakes(env, { graceSec: REPAIR_GRACE_SEC, scatterMax: REPAIR_SCATTER_MAX_SEC });
    result = {
      skipped: repair.skipped,
      reported: repair.reported,
      started: repair.started,
      success: 0,
      fail: 0,
      leftoverReports: repair.leftoverReports,
      leftoverStarts: repair.leftoverStarts,
      wallMs: 0,
    };
    if (shouldTrimLogs()) await trimLogs(env);
  } catch (e) {
    status = "error";
    result.skipped = e instanceof Error ? e.message : String(e);
    listenLog("tick.fail", result.skipped);
  }

  result.wallMs = Date.now() - t0;
  listenLog(
    "tick.done",
    `started=${result.started} reported=${result.reported} leftoverStarts=${result.leftoverStarts} leftoverReports=${result.leftoverReports} wallMs=${result.wallMs}${result.skipped ? ` skipped=${result.skipped}` : ""}`,
  );
  await writeHeartbeat(env, {
    at: nowSec(),
    status,
    wallMs: result.wallMs,
    started: result.started,
    reported: result.reported,
    leftoverStarts: result.leftoverStarts,
    leftoverReports: result.leftoverReports,
    message: result.skipped,
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

export async function onListenEnabledChange(env: Env, enabled: boolean): Promise<void> {
  if (!enabled) return;
  await repairStuckWakes(env, { graceSec: 0, scatterMax: BIND_START_MAX_SEC });
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
  const t0 = Date.now();
  const repair = await repairStuckWakes(env, {
    graceSec: 0,
    scatterMax: KICK_SCATTER_MAX_SEC,
    forceIdleStarts: true,
  });
  const wallMs = Date.now() - t0;
  listenLog("kick", `started=${repair.started} reported=${repair.reported}`);
  await writeHeartbeat(env, {
    at: nowSec(),
    status: "ok",
    wallMs,
    started: repair.started,
    reported: repair.reported,
    leftoverStarts: repair.leftoverStarts,
    leftoverReports: repair.leftoverReports,
    message: repair.skipped,
  });
  return {
    skipped: repair.skipped,
    scattered: repair.started + repair.reported,
    reported: repair.reported,
    started: repair.started,
    success: 0,
    fail: 0,
    leftoverReports: repair.leftoverReports,
    leftoverStarts: repair.leftoverStarts,
    wallMs,
  };
}
