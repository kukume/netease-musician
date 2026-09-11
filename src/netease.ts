import { randomBytes } from "node:crypto";
import { md5 } from "./crypto";
import { weapiEncrypt } from "./weapi";

export const ORIGIN = "https://music.163.com";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const PLAYER_URL = ORIGIN + "/weapi/song/enhance/player/url/v1";
const ACCOUNT_GET = "/weapi/w/nuser/account/get";
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

export class QrBlockedError extends Error {
  constructor(
    message: string,
    readonly kind: "verify" | "fail" = "fail",
  ) {
    super(message);
    this.name = "QrBlockedError";
  }
}

export class CookieExpiredError extends Error {
  constructor(message = "网易云登录已失效，请重新扫码或粘贴 Cookie") {
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
  artistIds?: string[];
};

export type PlaylistInfo = {
  playlistId: string;
  name: string;
  cover: string;
  creatorId: string;
  tracks: PlaylistTrack[];
};

export type PlayLogSource = {
  playlistId?: string;
  creatorId?: string;
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

export function parseNeteaseCookie(raw: string): string {
  let text = (raw || "").trim();
  if (!text) throw new Error("请粘贴网易云 Cookie");
  if (text.toLowerCase().startsWith("cookie:")) text = text.slice(7).trim();
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      text = String(obj.cookie || obj.Cookie || obj.value || "");
    } catch {
      throw new Error("Cookie 格式无法识别");
    }
  }
  text = text.replace(/\r/g, "").replace(/\n+/g, "; ");
  const cookie = mergeCookie(text);
  if (!cookie.includes("MUSIC_U=")) throw new Error("Cookie 里没有 MUSIC_U，请复制登录后的完整 Cookie");
  if (!cookie.includes("__csrf=")) throw new Error("Cookie 里没有 __csrf，请复制完整 Cookie");
  return cookie;
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

function qrBlocked(json: Record<string, unknown>, code: number): QrBlockedError | null {
  const data = (json.data as Record<string, unknown> | undefined) || {};
  const msg = String(json.message || json.msg || data.blockText || json.blockText || "").trim();
  const verifyUrl = String(json.verifyUrl || data.verifyUrl || "");
  const verifyType = json.verifyType ?? data.verifyType;
  const isVerify =
    code === 250 ||
    code === 406 ||
    code === 415 ||
    code === 8821 ||
    code === -462 ||
    Boolean(verifyUrl) ||
    verifyType != null ||
    /需要验证|安全验证|图形验证|滑块|云盾|安全风险|切换其他登录/.test(msg);
  if (isVerify) {
    return new QrBlockedError(msg || "网易云需要安全验证，扫码无法完成", "verify");
  }
  if (code !== 803) {
    return new QrBlockedError(msg || `网易云登录失败，错误代码 ${code}`, "fail");
  }
  return null;
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
  const blocked = qrBlocked(json, code);
  if (blocked) throw blocked;
  const merged = mergeCookie(session.cookie, cookie, renderSetCookie(response));
  if (!merged.includes("MUSIC_U=")) throw new QrBlockedError("未获取到网易云登录 cookie", "fail");
  return { cookie: merged, profile: json };
}

export type SmsSession = {
  cookie: string;
  phone: string;
  countrycode: string;
};

export function normalizePhone(raw: string, countrycode = "86"): { phone: string; countrycode: string } {
  let phone = (raw || "").trim().replace(/[\s-]/g, "");
  let cc = String(countrycode || "86").replace(/\D/g, "") || "86";
  if (phone.startsWith("+")) {
    const m = phone.match(/^\+(\d{1,4})(\d{6,15})$/);
    if (!m) throw new Error("请输入正确的手机号");
    cc = m[1];
    phone = m[2];
  } else if (cc === "86" && phone.startsWith("86") && phone.length === 13) {
    phone = phone.slice(2);
  }
  if (cc === "86") {
    if (!/^1\d{10}$/.test(phone)) throw new Error("请输入正确的手机号");
  } else if (!/^\d{6,15}$/.test(phone)) {
    throw new Error("请输入正确的手机号");
  }
  return { phone, countrycode: cc };
}

function assertCellphoneLogin(json: Record<string, unknown>) {
  const code = Number(json.code ?? -1);
  const data = (json.data as Record<string, unknown> | undefined) || {};
  const blocked = qrBlocked(json, code === 803 ? 803 : code);
  if (blocked?.kind === "verify") throw blocked;
  if (code === 200 || code === 803 || json.profile || data.userId) return;
  const msg = String(json.message || json.msg || data.blockText || "").trim();
  throw new Error(msg || `网易云登录失败，错误代码 ${code}`);
}

export async function sendSmsCode(phone: string, countrycode = "86"): Promise<SmsSession> {
  const parsed = normalizePhone(phone, countrycode);
  const cookie0 = await bootstrap();
  const { json, cookie } = await weapiPost(
    "/weapi/sms/captcha/sent",
    {
      cellphone: parsed.phone,
      ctcode: parsed.countrycode,
      secrete: "music_user_login",
      noCheckToken: true,
    },
    cookie0,
  );
  const code = Number(json.code ?? -1);
  if (code === -12) throw new Error("网易云要求图形验证码，请改用扫码或 Cookie 登录");
  if (code === 8821) throw new Error(String(json.message || "请切换其他登录方式或升级新版本再试"));
  if (code !== 200) throw new Error(String(json.message || `网易云发送验证码失败，错误代码 ${code}`));
  return { cookie, phone: parsed.phone, countrycode: parsed.countrycode };
}

export async function loginBySms(
  session: SmsSession,
  captcha: string,
): Promise<{ cookie: string; profile?: Record<string, unknown> }> {
  const code = (captcha || "").trim();
  if (!code) throw new Error("请输入验证码");
  const { json, cookie, response } = await weapiPost(
    "/weapi/login/cellphone",
    {
      countrycode: session.countrycode,
      phone: session.phone,
      captcha: code,
      rememberLogin: "true",
      noCheckToken: true,
      ydDeviceToken: "",
    },
    session.cookie,
    { loginMethod: "Cellphone" },
  );
  assertCellphoneLogin(json);
  const merged = mergeCookie(session.cookie, cookie, renderSetCookie(response));
  if (!merged.includes("MUSIC_U=")) throw new Error("未获取到网易云登录 cookie");
  return { cookie: merged, profile: json };
}

export async function fetchAccount(cookie: string): Promise<{ uid: string; nickname: string; avatar: string }> {
  const { json, response } = await weapiPost(ACCOUNT_GET, {}, cookie, { loginSensitive: true });
  throwIfCookieExpired(response, json);
  const profile = (json.profile as Record<string, unknown> | undefined) || {};
  const account = (json.account as Record<string, unknown> | undefined) || {};
  const uid = String(profile.userId || account.id || "");
  if (!uid || account.anonimousUser === true) {
    listenLog("cookie.expired", `profile=${json.profile == null ? "null" : "empty"} anonymous=${account.anonimousUser === true}`);
    throw new CookieExpiredError();
  }
  return {
    uid,
    nickname: String(profile.nickname || "网易云用户"),
    avatar: String(profile.avatarUrl || ""),
  };
}

/** 音乐人资料里的 artistId 才对应歌曲 ar[].id，和登录 userId 不是同一套。 */
export async function fetchUserArtistId(cookie: string, uid: string): Promise<string> {
  if (!uid) return "";
  try {
    const { json } = await weapiPost(`/weapi/w/v1/user/detail/${encodeURIComponent(uid)}`, {}, cookie);
    const profile = (json.profile as Record<string, unknown> | undefined) || {};
    const id = profile.artistId;
    return id == null || id === "" ? "" : String(id);
  } catch {
    return "";
  }
}

/** 开听前探活：资料接口有 profile 才算登录有效。失效时常仍是 HTTP 200、profile=null。 */
export async function assertCookieValid(cookie: string): Promise<{ uid: string; nickname: string }> {
  const me = await fetchAccount(cookie);
  return { uid: me.uid, nickname: me.nickname };
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
  const artists =
    (raw.ar as Array<{ id?: unknown; name?: string }> | undefined) ||
    (raw.artists as Array<{ id?: unknown; name?: string }> | undefined) ||
    [];
  const album = (raw.al as Record<string, unknown> | undefined) || (raw.album as Record<string, unknown> | undefined) || {};
  return {
    songId: String(id),
    name: String(raw.name || "未知歌曲"),
    artist: artists.map((a) => a.name).filter(Boolean).join(" / ") || "未知歌手",
    album: String(album.name || ""),
    duration: Number(raw.dt || raw.duration || 0),
    cover: String(album.picUrl || ""),
    artistIds: artists.map((a) => (a.id == null ? "" : String(a.id))).filter(Boolean),
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
  const creatorId = playlistCreatorId(playlist);
  listenLog("playlist.detail", `id=${playlistId} tracks=${ordered.length} creator=${creatorId || "-"}`);
  return {
    playlistId: String(playlist.id || playlistId),
    name: String(playlist.name || "未命名歌单"),
    cover: String(playlist.coverImgUrl || ""),
    creatorId,
    tracks: ordered,
  };
}

function playlistCreatorId(playlist: Record<string, unknown>): string {
  const creator = playlist.creator as Record<string, unknown> | undefined;
  const raw = creator?.userId ?? creator?.id ?? playlist.userId;
  return raw == null || raw === "" ? "" : String(raw);
}

export async function fetchPlaylistCreator(cookie: string, playlistId: string): Promise<string> {
  const { json } = await weapiPost("/weapi/v6/playlist/detail", { id: playlistId, n: 1, s: 1 }, cookie);
  const playlist = json.playlist as Record<string, unknown> | undefined;
  return playlist ? playlistCreatorId(playlist) : "";
}

export async function fetchPublicPlaylist(playlistId: string): Promise<PlaylistInfo> {
  const cookie = await bootstrap();
  return fetchPlaylist(cookie, playlistId);
}

async function weblog(
  cookie: string,
  action: string,
  js: Record<string, unknown>,
  label?: string,
): Promise<Record<string, unknown>> {
  const payload = {
    logs: JSON.stringify([
      {
        action,
        json: { ...js, mainsite: "1", mainsiteWeb: "1" },
      },
    ]),
  };
  const { json } = await weapiPost(WEBLOG_URL, payload, cookie, { loginSensitive: true });
  listenLog(`weblog.${label || action}`, compactJson(json));
  return json;
}

/** 官网把 content 写成当前页 query：id=歌单&creatorId=&sharedId= */
function playLogContent(songId: string, source?: PlayLogSource): string {
  const playlistId = source?.playlistId;
  if (playlistId && source?.creatorId) {
    return `id=${playlistId}&creatorId=${source.creatorId}&sharedId=${source.creatorId}`;
  }
  return `id=${playlistId || songId}`;
}

function playOpenSource(songId: string, playlistId?: string): Record<string, unknown> {
  if (playlistId) return { source: "list", sourceid: playlistId };
  return { source: "song", sourceid: songId };
}

function playEndSource(songId: string, playlistId?: string): Record<string, unknown> {
  if (playlistId) return { source: "list", sourceId: playlistId };
  return { source: "song", sourceId: songId };
}

function toHttps(url: string): string {
  return url.replace(/^https?:/, "https:");
}

export async function bumpPlaylistPlaycount(cookie: string, playlistId: string): Promise<void> {
  const { json, response } = await weapiPost(
    "/weapi/playlist/update/playcount",
    { id: playlistId },
    cookie,
    { loginSensitive: true },
  );
  listenLog("playlist.playcount", `id=${playlistId} http=${response.status} ${compactJson(json)}`);
}

const AUDIO_PAGE_BYTES = 100 * 1024;

/** 只拉第一页 100KB：Range bytes=0-102399，读满或流结束就停。 */
export async function fetchPlayAudio(playUrl: string): Promise<{ ok: boolean; status: number; bytes: number }> {
  const url = toHttps(playUrl);
  const last = AUDIO_PAGE_BYTES - 1;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Referer: `${ORIGIN}/`,
      Accept: "*/*",
      "Accept-Encoding": "identity;q=1, *;q=0",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Range: `bytes=0-${last}`,
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  let bytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (bytes < AUDIO_PAGE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const ok = response.status === 206 || response.status === 200;
  listenLog(
    "audio.get",
    `http=${response.status} bytes=${bytes} range=${response.headers.get("content-range") || `0-${last}`}`,
  );
  return { ok, status: response.status, bytes };
}

export async function startPlaySession(
  cookie: string,
  songId: string,
  options?: { level?: string; fallbackDurationMs?: number } & PlayLogSource,
): Promise<{ durationS: number; playUrl: string }> {
  const level = options?.level || "exhigh";
  const source: PlayLogSource = { playlistId: options?.playlistId, creatorId: options?.creatorId };
  const urlPromise = weapiPost(
    PLAYER_URL,
    { ids: JSON.stringify([Number(songId)]), level, encodeType: "aac" },
    cookie,
    { loginSensitive: true },
  );
  await weblog(
    cookie,
    "play",
    {
      id: String(songId),
      type: "song",
      content: playLogContent(songId, source),
      ...playOpenSource(songId, source.playlistId),
    },
    "play.open",
  );
  if (source.playlistId) {
    try {
      await bumpPlaylistPlaycount(cookie, source.playlistId);
    } catch (e) {
      listenLog("playlist.playcount.fail", `${source.playlistId} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const { json, response } = await urlPromise;
  throwIfCookieExpired(response, json);
  const list = (json.data as Array<Record<string, unknown>> | undefined) || [];
  const info = list[0];
  if (Number(json.code) !== 200 || !info) throw new Error("获取播放地址失败");
  if (!info.url) throw new Error("没有播放地址，可能是会员/版权限制");
  const fromPlayer = Number(info.time || 0) / 1000;
  const fallback = Number(options?.fallbackDurationMs || 0) / 1000;
  const durationS = Math.min(MAX_SONG_SECONDS, Math.max(0, fromPlayer || fallback));
  const playUrl = toHttps(String(info.url));
  listenLog(
    "player.url",
    `id=${info.id || songId} http=${response.status} code=${json.code} br=${info.br} size=${info.size} type=${info.type} level=${info.level} duration=${durationS.toFixed(3)}s playlist=${options?.playlistId || "-"}`,
  );
  await weblog(
    cookie,
    "startplay",
    { id: String(songId), type: "song", content: playLogContent(songId, source) },
    "play.startplay",
  );
  return { durationS, playUrl };
}

export async function finishPlaySession(
  cookie: string,
  songId: string,
  durationS: number,
  sourceId?: string,
  options?: { creatorId?: string },
): Promise<{ ok: boolean; time: number; message: string }> {
  if (durationS <= MIN_REPORT_SECONDS) {
    listenLog("play.skip", `id=${songId} duration=${durationS}s`);
    return { ok: false, time: 0, message: `歌曲过短，未上报 play（需 > ${MIN_REPORT_SECONDS}s）` };
  }
  const time = Math.round(durationS);
  const source: PlayLogSource = { playlistId: sourceId, creatorId: options?.creatorId };
  const play = await weblog(
    cookie,
    "play",
    {
      type: "song",
      wifi: 0,
      download: 0,
      id: String(songId),
      time,
      end: "playend",
      content: playLogContent(songId, source),
      ...playEndSource(songId, source.playlistId),
    },
    "play.end",
  );
  const ok = Number(play.code) === 200 || play.data === "success";
  return { ok, time, message: ok ? "播放上报成功" : JSON.stringify(play) };
}
