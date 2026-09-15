import { randomBytes } from "node:crypto";
import * as zlib from "node:zlib";

const UPLOAD_URL = "https://clientlog3.music.163.com/api/clientlog/encrypt/upload?multiupload=true";
const DESKTOP_VER = "3.1.35";
const DESKTOP_VER_CODE = "205293";
const DESKTOP_OSVER = "Microsoft-Windows-10-Professional-build-19045-64bit";

const MAGIC = Buffer.from("NCBL", "ascii");
const NCBL_VERSION = 3;
const HEADER_FIXED_LEN = 70;
const META_BLOCK_TYPE = 0x4343;
const DEFAULT_MAX_FRAME = 0x8000;
const FIELD_SEP = "\x01";

const RSA_N = 0xfd90bd466ff9bc8a3fec2fbcf263b90d5c564879fa5d7aab89b31c1d5cb4139dn;
const RSA_E = 65537n;
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

export type NcblSong = {
  id: string | number;
  name?: string;
  artist?: string;
  bitrate?: number;
  level?: string;
  time: number;
};

export type NcblSource = {
  id: string;
  type?: string;
  name?: string;
};

export type NcblUploadResult = {
  ok: boolean;
  status: number;
  fileName: string;
  body: Record<string, unknown>;
};

type NcblContext = {
  app: {
    nsm: string;
    cid: string;
    channel: string;
    version: string;
    versionCode: string;
  };
  device: {
    id: string;
    ti: string;
    sign: string;
    model: string;
    nnid: string;
    nuid: string;
    csrf: string;
    systemType: string;
    systemVersion: string;
  };
  auth: {
    id: string;
    token: string;
    sessionId: string;
    vipType: string;
  };
};

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] ^= s[a];
  s[d] = rotl(s[d], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] ^= s[c];
  s[b] = rotl(s[b], 12);
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] ^= s[a];
  s[d] = rotl(s[d], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] ^= s[c];
  s[b] = rotl(s[b], 7);
}

function chachaBlock(key: Buffer, counter: number, nonce: Buffer): Buffer {
  const state = new Uint32Array(16);
  state[0] = SIGMA[0];
  state[1] = SIGMA[1];
  state[2] = SIGMA[2];
  state[3] = SIGMA[3];
  for (let i = 0; i < 8; i++) state[4 + i] = key.readUInt32LE(i * 4);
  state[12] = counter >>> 0;
  state[13] = nonce.readUInt32LE(0);
  state[14] = nonce.readUInt32LE(4);
  state[15] = nonce.readUInt32LE(8);

  const work = state.slice();
  for (let i = 0; i < 10; i++) {
    quarterRound(work, 0, 4, 8, 12);
    quarterRound(work, 1, 5, 9, 13);
    quarterRound(work, 2, 6, 10, 14);
    quarterRound(work, 3, 7, 11, 15);
    quarterRound(work, 0, 5, 10, 15);
    quarterRound(work, 1, 6, 11, 12);
    quarterRound(work, 2, 7, 8, 13);
    quarterRound(work, 3, 4, 9, 14);
  }

  const out = Buffer.allocUnsafe(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE((work[i] + state[i]) >>> 0, i * 4);
  return out;
}

function chacha20(key: Buffer, counter: number, nonce: Buffer, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  for (let off = 0; off < data.length; off += 64) {
    const ks = chachaBlock(key, (counter + (off >>> 6)) >>> 0, nonce);
    const end = Math.min(off + 64, data.length);
    for (let i = off; i < end; i++) out[i] = data[i] ^ ks[i - off];
  }
  return out;
}

function beToBig(buf: Buffer): bigint {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

function bigToBe(n: bigint, len: number): Buffer {
  const out = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

function rsaWrap(keyA: Buffer): Buffer {
  return bigToBe(modPow(beToBig(keyA), RSA_E, RSA_N), 32);
}

function compressBody(buf: Buffer): Buffer {
  const zstd = (zlib as { zstdCompressSync?: (data: Buffer) => Buffer }).zstdCompressSync;
  if (typeof zstd === "function") return zstd(buf);
  return zlib.gzipSync(buf);
}

function encryptNcbl(meta: string, body: string): Buffer {
  const metaBuf = Buffer.from(meta, "utf-8");
  const bodyBuf = Buffer.from(body, "utf-8");
  const keyA = randomBytes(32);
  if (keyA[0] >= 0xa3) keyA[0] = 0xa2;
  const keyB = rsaWrap(keyA);

  const uuid = randomBytes(16);
  uuid[6] = (uuid[6] & 0x0f) | 0x40;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const nonce = uuid.subarray(0, 12);
  const counter = uuid.readUInt32LE(12) >>> 2;
  const baseSeq = randomBytes(2).readUInt16LE(0);

  const metaCipher = chacha20(keyB, counter, nonce, metaBuf);
  const metaHead = Buffer.allocUnsafe(4);
  metaHead.writeUInt16LE(META_BLOCK_TYPE, 0);
  metaHead.writeUInt16LE(metaCipher.length, 2);
  const metaBlock = Buffer.concat([metaHead, metaCipher]);
  const headerLen = HEADER_FIXED_LEN + metaBlock.length;

  const compressed = compressBody(bodyBuf);
  const frames: Buffer[] = [];
  let seq = baseSeq;
  for (let off = 0; off < compressed.length || off === 0; off += DEFAULT_MAX_FRAME) {
    const slice = compressed.subarray(off, off + DEFAULT_MAX_FRAME);
    const cipher = chacha20(keyA, counter, nonce, slice);
    const head = Buffer.allocUnsafe(6);
    head.writeUInt16LE(cipher.length, 0);
    head.writeUInt32LE(seq >>> 0, 2);
    frames.push(head, cipher);
    seq++;
    if (compressed.length === 0) break;
  }

  const trailing = Buffer.concat(frames);
  const frameCount = seq - baseSeq;
  const header = Buffer.alloc(HEADER_FIXED_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(NCBL_VERSION, 4);
  header.writeUInt16LE(headerLen, 8);
  uuid.copy(header, 10);
  keyB.copy(header, 26);
  header.writeUInt32LE(baseSeq >>> 0, 58);
  header.writeUInt32LE((baseSeq + frameCount - 1) >>> 0, 62);
  header.writeUInt32LE(trailing.length, 66);
  return Buffer.concat([header, metaBlock, trailing]);
}

function parseCookie(cookie: string): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) obj[key] = val;
  }
  return obj;
}

function extractContext(cookie: string): NcblContext {
  const c = parseCookie(cookie);
  return {
    app: {
      nsm: c.WEVNSM || "1.0.0",
      cid: c.WNMCID || `${randomBytes(3).toString("hex")}.${Date.now()}.01.0`,
      channel: c.channel || "netease",
      version: DESKTOP_VER,
      versionCode: DESKTOP_VER_CODE,
    },
    device: {
      id: c.deviceId || c.sDeviceId || "",
      ti: c.NMTID || "",
      sign: c.clientSign || "",
      model: c.mode || c.mobilename || "",
      nnid: c._ntes_nnid || ",",
      nuid: c._ntes_nuid || "",
      csrf: c.__csrf || "",
      systemType: "pc",
      systemVersion: c.osver || DESKTOP_OSVER,
    },
    auth: {
      id: c.uid || "",
      token: c.MUSIC_U || "",
      sessionId: c["JSESSIONID-WYYY"] || "",
      vipType: c.vipType || "",
    },
  };
}

function buildCookieStr(ctx: NcblContext): string {
  return [
    `JSESSIONID-WYYY=${ctx.auth.sessionId}`,
    `MUSIC_U=${ctx.auth.token}`,
    `NMTID=${ctx.device.ti}`,
    `WEVNSM=${ctx.app.nsm}`,
    `WNMCID=${ctx.app.cid}`,
    `__csrf=${ctx.device.csrf}`,
    `__remember_me=true`,
    `_iuqxldmzr_=33`,
    `_ntes_nnid=${ctx.device.nnid}`,
    `_ntes_nuid=${ctx.device.nuid}`,
    `appver=${ctx.app.version}.${ctx.app.versionCode}`,
    `channel=${ctx.app.channel}`,
    `clientSign=${ctx.device.sign}`,
    `deviceId=${ctx.device.id}`,
    `mode=${ctx.device.model}`,
    `ntes_kaola_ad=1`,
    `os=${ctx.device.systemType}`,
    `osver=${ctx.device.systemVersion}`,
  ].join("; ");
}

function buildMetaJson(ctx: NcblContext): string {
  return JSON.stringify({
    "JSESSIONID-WYYY": ctx.auth.sessionId,
    MUSIC_U: ctx.auth.token,
    NMTID: ctx.device.ti,
    WEVNSM: ctx.app.nsm,
    WNMCID: ctx.app.cid,
    __csrf: ctx.device.csrf,
    _iuqxldmzr_: "33",
    _ntes_nnid: ctx.device.nnid,
    _ntes_nuid: ctx.device.nuid,
    appver: `${ctx.app.version}.${ctx.app.versionCode}`,
    channel: ctx.app.channel,
    clientSign: ctx.device.sign,
    deviceId: ctx.device.id,
    mode: ctx.device.model,
    ntes_kaola_ad: "1",
    os: ctx.device.systemType,
    osver: ctx.device.systemVersion,
  });
}

function buildPlv(ctx: NcblContext, song: NcblSong, source: NcblSource) {
  const now = Date.now();
  const sourceId = source.id || String(song.id);
  const addRefer = `[F:63][${now}#933#${ctx.app.version}#${ctx.app.versionCode}#c9156c3][e][2][23][cell_pc_songlist_song:2|page_pc_songlist_songflow|page_mine_like_music][${song.id}:song:x:x|:::|${sourceId}:list::]`;
  return {
    mode: "circulation",
    download: 0,
    alg: "",
    status: "front",
    id: String(song.id),
    bitrate: song.bitrate || 320,
    type: "song",
    is_listentogether: 0,
    source: source.name || "list",
    is_heart: 0,
    resource_ratio: "",
    resource_time: song.time,
    musiceffect_id: "",
    app_mode: 2,
    bitrate_level: song.level || "exhigh",
    _addrefer: addRefer,
    _multirefers: [
      "[F:26][s][18][_ai]",
      "[F:26][s][12][_ai]",
      `[F:63][${now}#933#${ctx.app.version}#${ctx.app.versionCode}#c9156c3][e][2][8][cell_pc_main_tab_entrance:6|page_pc_main_tab][我喜欢的音乐:spm::|:::]`,
      "[F:26][s][5][_ai]",
      "[F:26][s][0][_ai]",
    ],
    vipType: ctx.auth.vipType,
    fee: 1,
    file: 4,
    rightSource: 0,
    sourceId,
    sourcetype: source.type || "track",
    libra_abt: "",
    channel: ctx.app.channel,
    curStartChannel: "",
  };
}

function buildPld(ctx: NcblContext, song: NcblSong, source: NcblSource, played: number) {
  const now = Date.now();
  const sourceId = source.id || String(song.id);
  const addRefer = `[F:63][${now}#616#${ctx.app.version}#${ctx.app.versionCode}#c9156c3][e][2][92][btn_pc_cover_play|cell_pc_songlist_song:6|page_pc_songlist_songflow|page_mine_like_music][:::|${song.id}:song:x:x|:::|${sourceId}:list::]`;
  return {
    mode: "circulation",
    download: 0,
    alg: "",
    status: "front",
    id: String(song.id),
    time: played,
    type: "song",
    is_listentogether: 0,
    source: source.name || "list",
    is_heart: 0,
    realtime: played,
    resource_ratio: "",
    resource_time: song.time,
    musiceffect_id: "1001",
    app_mode: 1,
    lyriceffect: "default",
    displayMode: "classic",
    bitrate: song.bitrate || 320,
    bitrate_level: song.level || "exhigh",
    _addrefer: addRefer,
    _multirefers: ["[F:26][s][87][_ai]", "[F:26][s][81][_ai]", "[F:26][s][75][_ai]", "[F:26][s][69][_ai]", "[F:26][s][63][_ai]"],
    vipType: ctx.auth.vipType,
    fee: 8,
    file: 4,
    rightSource: 0,
    sourceId,
    sourcetype: source.type || "track",
    end: "interrupt",
    libra_abt: "",
    channel: ctx.app.channel,
    curStartChannel: "",
  };
}

function buildRecords(action: "_plv" | "_pld", data: Record<string, unknown>): string {
  const ts = Math.floor(Date.now() / 1000);
  return [ts, action, JSON.stringify(data)].join(FIELD_SEP);
}

function randFileName(seq: number): string {
  const a = 10000 + (randomBytes(2).readUInt16LE(0) % 90000);
  const rand = (randomBytes(4).readUInt32LE(0) % 4294967295) + 1;
  return `op_${a}_${seq}_${rand}`;
}

async function doUpload(ctx: NcblContext, body: string, seq: number): Promise<NcblUploadResult> {
  const payload = encryptNcbl(buildMetaJson(ctx), body);
  const fileName = randFileName(seq);
  const boundary = crypto.randomUUID();
  const crlf = "\r\n";
  const header =
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"${crlf}` +
    `Content-Type: multipart/form-data${crlf}${crlf}`;
  const footer = `${crlf}--${boundary}--${crlf}`;
  const multipart = Buffer.concat([Buffer.from(header, "utf-8"), payload, Buffer.from(footer, "utf-8")]);

  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Referer: "https://music.163.com/di",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/${ctx.app.version}`,
      "Accept-Encoding": "gzip,deflate",
      "Accept-Language": "zh-CN,zh;q=0.8",
      Cookie: buildCookieStr(ctx),
    },
    body: multipart,
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`听歌上报返回非 JSON (${response.status})`);
  }
  const data = (json.data as { successfiles?: string[] } | undefined) || {};
  const ok = Number(json.code) === 200 && Boolean(data.successfiles?.includes(fileName));
  return { ok, status: response.status, fileName, body: json };
}

export async function uploadPlv(cookie: string, song: NcblSong, source: NcblSource): Promise<NcblUploadResult> {
  const ctx = extractContext(cookie);
  if (!ctx.auth.token) throw new Error("缺少 MUSIC_U 鉴权令牌");
  return doUpload(ctx, buildRecords("_plv", buildPlv(ctx, song, source)), 0);
}

export async function uploadPld(
  cookie: string,
  song: NcblSong,
  source: NcblSource,
  played: number,
): Promise<NcblUploadResult> {
  const ctx = extractContext(cookie);
  if (!ctx.auth.token) throw new Error("缺少 MUSIC_U 鉴权令牌");
  return doUpload(ctx, buildRecords("_pld", buildPld(ctx, song, source, played)), 1);
}
