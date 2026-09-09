import { randomBytes } from "node:crypto";
import { md5 } from "./crypto";
import { weapiEncrypt } from "./weapi";

export const ORIGIN = "https://music.163.com";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const PLAYER_URL = ORIGIN + "/weapi/song/enhance/player/url/v1";
const WEBLOG_URL = "https://clientlogusf.music.163.com/weapi/feedback/weblog";
const DEVICE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export class QrWaitError extends Error {
  constructor(
    message: string,
    readonly code: 800 | 801 | 802,
  ) {
    super(message);
  }
}

export class CookieExpiredError extends Error {
  constructor(message = "网易云登录已失效，请重新扫码") {
    super(message);
    this.name = "CookieExpiredError";
  }
}

const EXPIRED_CODES = new Set([301, 302, 401, 403]);
export const MIN_REPORT_SECONDS = 3;
const MAX_SONG_SECONDS = 12 * 60;

export type QrSession = {
  unikey: string;
  url: string;
  chainId: string;
  cookie: string;
};

export type PlaylistTrack = {
  songId: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
};

export type PlaylistInfo = {
  playlistId: string;
  name: string;
  cover: string;
  tracks: PlaylistTrack[];
};

function randomFrom(chars: string, n: number): string {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function cookieValue(cookie: string, name: string): string {
  const prefix = name + "=";
  for (const part of cookie.split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return "";
}

function csrfFromCookie(cookie: string): string {
  return cookieValue(cookie, "__csrf");
}

export function mergeCookie(...parts: string[]): string {
  const seen = new Map<string, string>();
  for (const part of parts) {
    if (!part) continue;
    for (const item of part.split(";")) {
      const trimmed = item.trim();
      if (!trimmed || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!name || value === "" || value === "deleted") continue;
      seen.set(name, value);
    }
  }
  return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function renderSetCookie(res: Response): string {
  const headers = "getSetCookie" in res.headers ? res.headers.getSetCookie() : [];
  const extra = res.headers.get("set-cookie");
  const list = headers.length ? headers : extra ? [extra] : [];
  const parts: string[] = [];
  for (const header of list) {
    const nv = header.split(";", 1)[0].trim();
    if (!nv.includes("=")) continue;
    const [name, value] = nv.split("=", 2);
    if (value === "deleted") continue;
    parts.push(`${name}=${value}`);
  }
  return parts.join("; ");
}

function findSetCookie(res: Response, name: string): string | null {
  const headers = "getSetCookie" in res.headers ? res.headers.getSetCookie() : [];
  const prefix = name + "=";
  for (const header of headers) {
    const nv = header.split(";", 1)[0].trim();
    if (nv.startsWith(prefix)) return nv.slice(prefix.length);
  }
  return null;
}

function seedCookie(): string {
  const now = Date.now();
  const nuid = md5(`${now}${randomFrom(DEVICE_CHARS, 16)}`);
  const wnmcid = randomFrom("abcdefghijklmnopqrstuvwxyz", 6);
  const sdevice = "YD-" + randomFrom(DEVICE_CHARS, 32);
  return (
    `_iuqxldmzr_=32; WEVNSM=1.0.0; WNMCID=${wnmcid}.${now}.01.0; ` +
    `_ntes_nuid=${nuid}; _ntes_nnid=${nuid},${now}; sDeviceId=${sdevice}`
  );
}

function chainId(cookie: string): string {
  const device = cookieValue(cookie, "sDeviceId") || `unknown-${randomFrom("0123456789", 6)}`;
  return `v1_${device}_web_login_${Date.now()}`;
}

function listenLog(step: string, detail?: string) {
  console.log(detail ? `[listen] ${step} ${detail}` : `[listen] ${step}`);
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 400);
  } catch {
    return String(value);
  }
}

function throwIfCookieExpired(response: Response, json?: Record<string, unknown>) {
  if (response.status === 401 || response.status === 403) {
    listenLog("cookie.expired", `http=${response.status}`);
    throw new CookieExpiredError();
  }
  const code = Number(json?.code ?? 0);
  if (EXPIRED_CODES.has(code)) {
    listenLog("cookie.expired", `code=${code}`);
    throw new CookieExpiredError();
  }
}

function headers(
  cookie: string,
  extra?: { chainId?: string; loginMethod?: string; loginSensitive?: boolean },
): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": UA,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "*/*",
    "x-os": "web",
    "nm-gcore-status": "1",
    "x-channelsource": "undefined",
    Cookie: cookie.trim(),
  };
  if (extra?.loginMethod) h["X-loginMethod"] = extra.loginMethod;
  if (extra?.chainId) {
    h["X-loginMethod"] = "QrCode";
    h["x-login-chain-id"] = extra.chainId;
  }
  return h;
}

async function postForm(url: string, body: Record<string, string>, hdrs: Record<string, string>): Promise<Response> {
  const encoded = new URLSearchParams(body);
  return fetch(url, {
    method: "POST",
    headers: hdrs,
    body: encoded.toString(),
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
}

export async function weapiPost(
  pathOrUrl: string,
  payload: Record<string, unknown>,
  cookie: string,
  extra?: { chainId?: string; loginMethod?: string; loginSensitive?: boolean },
): Promise<{ json: Record<string, unknown>; cookie: string; response: Response }> {
  const csrf = csrfFromCookie(cookie);
  const body = { ...payload, csrf_token: csrf };
  const encrypted = weapiEncrypt(body);
  const base = pathOrUrl.startsWith("http") ? pathOrUrl : ORIGIN + pathOrUrl;
  const target = base + (base.includes("?") ? "&" : "?") + "csrf_token=" + encodeURIComponent(csrf);
  const response = await postForm(target, encrypted, headers(cookie, extra));
  if (extra?.loginSensitive && (response.status === 401 || response.status === 403)) {
    throw new CookieExpiredError();
  }
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (extra?.loginSensitive && (response.status === 401 || response.status === 403)) {
      throw new CookieExpiredError();
    }
    throw new Error(`网易云接口返回非 JSON (${response.status})`);
  }
  if (extra?.loginSensitive) throwIfCookieExpired(response, json);
  return { json, cookie: mergeCookie(cookie, renderSetCookie(response)), response };
}

async function bootstrap(): Promise<string> {
  const home = await fetch(ORIGIN + "/", {
    headers: { "User-Agent": UA, Referer: `${ORIGIN}/` },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  let cookie = mergeCookie(seedCookie(), renderSetCookie(home));
  const device = await weapiPost(
    "/weapi/middle/device-info/web/get",
    { ydDeviceType: "WebOnline", ydDeviceToken: "" },
    cookie,
  );
  const data = (device.json.data as Record<string, unknown> | undefined) || {};
  const sdevice = findSetCookie(device.response, "sDeviceId") || (data.sDeviceId as string | undefined);
  let extra = renderSetCookie(device.response);
  if (sdevice) extra = mergeCookie(extra, `sDeviceId=${sdevice}`);
  return mergeCookie(cookie, extra);
}

export async function getQrcode(): Promise<QrSession> {
  const cookie0 = await bootstrap();
  const cid = chainId(cookie0);
  const { json, cookie } = await weapiPost(
    "/weapi/login/qrcode/unikey",
    { type: 1, noCheckToken: true },
    cookie0,
  );
  const code = Number(json.code ?? -1);
  if (code === 8821) throw new Error(String(json.message || "请切换其他登录方式或升级新版本再试"));
  if (code !== 200 || !json.unikey) throw new Error(String(json.message || "网易云获取二维码失败"));
  const unikey = String(json.unikey);
  const url =
    `${ORIGIN}/st/platform/scanlogin?codekey=${unikey}` +
    `&chainId=${cid}&hdw_device=web&hdw_appid=web&hitExp=1`;
  return { unikey, url, chainId: cid, cookie };
}

export async function checkQrcode(session: QrSession): Promise<{ cookie: string; profile?: Record<string, unknown> }> {
  const { json, cookie, response } = await weapiPost(
    "/weapi/login/qrcode/client/login",
    { type: 1, noCheckToken: true, key: session.unikey, ydDeviceToken: "" },
    session.cookie,
    { chainId: session.chainId },
  );
  const code = Number(json.code ?? -1);
  if (code === 801) throw new QrWaitError("等待扫码", 801);
  if (code === 802) throw new QrWaitError("已扫码，等待确认", 802);
  if (code === 800) throw new QrWaitError("网易云二维码已过期", 800);
  if (code === 8821) throw new Error(String(json.message || "请切换其他登录方式或升级新版本再试"));
  if (code !== 803) throw new Error(String(json.message || `网易云登录失败，错误代码 ${code}`));
  const merged = mergeCookie(session.cookie, cookie, renderSetCookie(response));
  if (!merged.includes("MUSIC_U=")) throw new Error("未获取到网易云登录 cookie");
  return { cookie: merged, profile: json };
}

export async function fetchAccount(cookie: string): Promise<{ uid: string; nickname: string; avatar: string }> {
  const { json } = await weapiPost("/weapi/nuser/account/get", {}, cookie);
  const profile = (json.profile as Record<string, unknown> | undefined) || {};
  const account = (json.account as Record<string, unknown> | undefined) || {};
  const uid = String(profile.userId || account.id || "");
  return {
    uid,
    nickname: String(profile.nickname || "网易云用户"),
    avatar: String(profile.avatarUrl || ""),
  };
}

export function parsePlaylistId(input: string): string {
  const t = input.trim();
  const m = t.match(/[?&]id=(\d+)/) || t.match(/playlist\/(\d+)/) || t.match(/^(\d+)$/);
  if (!m) throw new Error("无效的歌单链接或 ID");
  return m[1];
}

function mapTrack(raw: Record<string, unknown>): PlaylistTrack | null {
  const id = raw.id;
  if (id == null) return null;
  const artists = (raw.ar as Array<{ name?: string }> | undefined) || (raw.artists as Array<{ name?: string }> | undefined) || [];
  const album = (raw.al as Record<string, unknown> | undefined) || (raw.album as Record<string, unknown> | undefined) || {};
  return {
    songId: String(id),
    name: String(raw.name || "未知歌曲"),
    artist: artists.map((a) => a.name).filter(Boolean).join(" / ") || "未知歌手",
    album: String(album.name || ""),
    duration: Number(raw.dt || raw.duration || 0),
    cover: String(album.picUrl || ""),
  };
}

async function fetchSongDetails(cookie: string, ids: string[]): Promise<Map<string, PlaylistTrack>> {
  const out = new Map<string, PlaylistTrack>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { json } = await weapiPost(
      "/weapi/v3/song/detail",
      {
        c: JSON.stringify(chunk.map((id) => ({ id }))),
        ids: JSON.stringify(chunk.map((id) => Number(id))),
      },
      cookie,
    );
    const songs = (json.songs as Array<Record<string, unknown>> | undefined) || [];
    for (const song of songs) {
      const mapped = mapTrack(song);
      if (mapped) out.set(mapped.songId, mapped);
    }
  }
  return out;
}

async function apiPost(
  path: string,
  payload: Record<string, string>,
  cookie: string,
): Promise<Record<string, unknown>> {
  const response = await postForm(ORIGIN + path, payload, headers(cookie));
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`网易云接口返回非 JSON (${response.status})`);
  }
}

export async function fetchPlaylist(cookie: string, playlistId: string): Promise<PlaylistInfo> {
  const { json } = await weapiPost("/weapi/v6/playlist/detail", { id: playlistId, n: 100000, s: 8 }, cookie);
  if (Number(json.code) !== 200) throw new Error(String(json.message || "获取歌单失败"));
  const playlist = json.playlist as Record<string, unknown> | undefined;
  if (!playlist) throw new Error("歌单不存在或无权访问");

  let trackIds = ((playlist.trackIds as Array<{ id?: number }> | undefined) || []).map((t) => String(t.id)).filter(Boolean);
  try {
    const apiJson = await apiPost("/api/v6/playlist/detail", { id: playlistId, n: "100000", s: "8" }, cookie);
    const apiPlaylist = apiJson.playlist as Record<string, unknown> | undefined;
    const apiIds = ((apiPlaylist?.trackIds as Array<{ id?: number }> | undefined) || []).map((t) => String(t.id)).filter(Boolean);
    if (apiIds.length > trackIds.length) trackIds = apiIds;
  } catch {
    listenLog("playlist.ids.fallback", `id=${playlistId} weapiIds=${trackIds.length}`);
  }

  const tracksRaw = (playlist.tracks as Array<Record<string, unknown>> | undefined) || [];
  const mapped = tracksRaw.map(mapTrack).filter((t): t is PlaylistTrack => !!t);
  const have = new Set(mapped.map((t) => t.songId));
  const missing = (trackIds.length ? trackIds : mapped.map((t) => t.songId)).filter((id) => id && !have.has(id));
  if (missing.length) {
    const extra = await fetchSongDetails(cookie, missing);
    for (const id of missing) {
      const t = extra.get(id);
      if (t) mapped.push(t);
    }
  }
  const ordered = trackIds.length
    ? trackIds.map((id) => mapped.find((t) => t.songId === id)).filter((t): t is PlaylistTrack => !!t)
    : mapped;
  listenLog("playlist.detail", `id=${playlistId} tracks=${ordered.length}`);
  return {
    playlistId: String(playlist.id || playlistId),
    name: String(playlist.name || "未命名歌单"),
    cover: String(playlist.coverImgUrl || ""),
    tracks: ordered,
  };
}

export async function fetchPublicPlaylist(playlistId: string): Promise<PlaylistInfo> {
  const cookie = await bootstrap();
  return fetchPlaylist(cookie, playlistId);
}

const AUDIO_PAGE_BYTES = 256 * 1024;
const AUDIO_PAGE_TIMEOUT_MS = 20_000;
const AUDIO_PAGE_RETRIES = 3;

function httpsUrl(url: string): string {
  if (url.startsWith("http://")) return "https://" + url.slice("http://".length);
  return url;
}

function audioRangeHeader(offset: number, pageBytes: number, total?: number): string {
  const last = offset + pageBytes - 1;
  const end = total && total > 0 ? Math.min(last, total - 1) : last;
  return `bytes=${offset}-${end}`;
}

function totalFromContentRange(header: string | null): number {
  const match = /\/(\d+)\s*$/.exec(header || "");
  return match ? Number(match[1]) : 0;
}

async function yieldBriefly(): Promise<void> {
  const sched = (globalThis as unknown as { scheduler?: { wait(delay: number): Promise<void> } }).scheduler;
  if (sched?.wait) await sched.wait(1);
}

async function discardBody(res: Response): Promise<number> {
  const body = res.body;
  if (!body) return 0;
  let n = 0;
  await body.pipeTo(
    new WritableStream({
      write(chunk) {
        n += (chunk as Uint8Array).byteLength;
      },
    }),
  );
  return n;
}

function audioHeaders(cookie: string, range: string): HeadersInit {
  return {
    "User-Agent": UA,
    Referer: ORIGIN + "/",
    Cookie: cookie,
    Range: range,
    "Accept-Encoding": "identity;q=1, *;q=0",
    "Sec-Fetch-Dest": "audio",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
  };
}

async function pullAudioPage(
  cookie: string,
  url: string,
  offset: number,
  pageBytes: number,
  total?: number,
): Promise<{ status: number; bytes: number; total: number; ranged: boolean }> {
  const range = audioRangeHeader(offset, pageBytes, total);
  const res = await fetch(url, {
    headers: audioHeaders(cookie, range),
    signal: AbortSignal.timeout(AUDIO_PAGE_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    listenLog("audio.fail", `GET ${res.status} song-url`);
    throw new CookieExpiredError();
  }
  if (res.status === 416) {
    return { status: 416, bytes: 0, total: total || 0, ranged: true };
  }
  if (!res.ok && res.status !== 206) throw new Error(`音频 GET ${res.status}`);
  const contentRange = res.headers.get("Content-Range");
  const ranged = res.status === 206 || !!contentRange;
  const knownTotal = totalFromContentRange(contentRange) || total || 0;
  const bytes = await discardBody(res);
  return { status: res.status, bytes, total: knownTotal, ranged };
}

async function pullAudioPageRetry(
  cookie: string,
  url: string,
  offset: number,
  pageBytes: number,
  total?: number,
): Promise<{ status: number; bytes: number; total: number; ranged: boolean }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AUDIO_PAGE_RETRIES; attempt++) {
    try {
      return await pullAudioPage(cookie, url, offset, pageBytes, total);
    } catch (e) {
      if (e instanceof CookieExpiredError) throw e;
      lastError = e;
      listenLog(
        "audio.page.retry",
        `offset=${offset} attempt=${attempt}/${AUDIO_PAGE_RETRIES} ${e instanceof Error ? e.message : String(e)}`,
      );
      await yieldBriefly();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function pullAudio(cookie: string, url: string, sizeHint?: number): Promise<number> {
  const target = httpsUrl(url);
  let offset = 0;
  let total = sizeHint && sizeHint > 0 ? sizeHint : 0;
  let pulled = 0;
  let page = 0;
  let eof = false;

  while (!total || offset < total) {
    page += 1;
    const range = audioRangeHeader(offset, AUDIO_PAGE_BYTES, total || undefined);
    listenLog("audio.page", `page=${page} range=${range}`);

    const result = await pullAudioPageRetry(cookie, target, offset, AUDIO_PAGE_BYTES, total || undefined);
    if (result.total) total = result.total;
    if (result.status === 416) {
      if (pulled <= 0) throw new Error("音频 Range 416，没有可拉的数据");
      eof = true;
      break;
    }
    if (result.bytes <= 0) {
      if (pulled <= 0) throw new Error("音频为空");
      eof = true;
      break;
    }

    pulled += result.bytes;
    offset += result.bytes;
    listenLog(
      "audio.page.ok",
      `page=${page} status=${result.status} got=${result.bytes} pulled=${pulled} total=${total || "-"}`,
    );

    if (!result.ranged) {
      listenLog("audio.no-range", `status=${result.status} 服务端未分页，已在同一响应里读完`);
      eof = true;
      break;
    }
    await yieldBriefly();
  }

  if (!eof && total && pulled < total) {
    throw new Error(`音频未拉完 pulled=${pulled} total=${total}`);
  }
  listenLog("audio.done", `bytes=${pulled} pages=${page} total=${total || "-"}`);
  return pulled;
}

async function weblog(cookie: string, action: string, js: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = {
    logs: JSON.stringify([
      {
        action,
        json: { ...js, mainsite: "1", mainsiteWeb: "1" },
      },
    ]),
  };
  const { json } = await weapiPost(WEBLOG_URL, payload, cookie, { loginSensitive: true });
  listenLog(`weblog.${action}`, compactJson(json));
  return json;
}

export async function startPlaySession(
  cookie: string,
  songId: string,
  options?: { level?: string; pull?: boolean; fallbackDurationMs?: number },
): Promise<{ durationS: number }> {
  const level = options?.level || "exhigh";
  const pull = options?.pull !== false;
  const { json, response } = await weapiPost(
    PLAYER_URL,
    { ids: JSON.stringify([Number(songId)]), level, encodeType: "aac" },
    cookie,
    { loginSensitive: true },
  );
  throwIfCookieExpired(response, json);
  const list = (json.data as Array<Record<string, unknown>> | undefined) || [];
  const info = list[0];
  if (Number(json.code) !== 200 || !info) throw new Error("获取播放地址失败");
  if (!info.url) throw new Error("没有播放地址，可能是会员/版权限制");
  const fromPlayer = Number(info.time || 0) / 1000;
  const fallback = Number(options?.fallbackDurationMs || 0) / 1000;
  const durationS = Math.min(MAX_SONG_SECONDS, Math.max(0, fromPlayer || fallback));
  listenLog(
    "player.url",
    `id=${info.id || songId} http=${response.status} code=${json.code} br=${info.br} size=${info.size} type=${info.type} level=${info.level} duration=${durationS.toFixed(3)}s`,
  );
  if (pull) {
    listenLog("audio.begin", `id=${songId} size=${info.size || "-"} page=${AUDIO_PAGE_BYTES}`);
    await pullAudio(cookie, String(info.url), Number(info.size) || undefined);
  }
  await weblog(cookie, "startplay", { id: Number(songId), type: "song", content: `id=${songId}` });
  return { durationS };
}

export async function finishPlaySession(
  cookie: string,
  songId: string,
  durationS: number,
  sourceId?: string,
): Promise<{ ok: boolean; time: number; message: string }> {
  if (durationS <= MIN_REPORT_SECONDS) {
    listenLog("play.skip", `id=${songId} duration=${durationS}s`);
    return { ok: false, time: 0, message: `歌曲过短，未上报 play（需 > ${MIN_REPORT_SECONDS}s）` };
  }
  const time = Math.round(durationS);
  const play = await weblog(cookie, "play", {
    type: "song",
    wifi: 0,
    download: 0,
    id: Number(songId),
    time,
    end: "playend",
    source: sourceId ? "list" : "song",
    sourceId: sourceId || songId,
    content: `id=${songId}`,
  });
  const ok = Number(play.code) === 200 || play.data === "success";
  return { ok, time, message: ok ? "播放上报成功" : JSON.stringify(play) };
}
