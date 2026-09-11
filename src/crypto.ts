import {
  createCipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Cloudflare Workers reject PBKDF2 iteration counts above 100000. */
const PBKDF2_ITERS = 100_000;
const AES_IV = Buffer.from("0102030405060708");

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

export function aesCbcBase64(text: string, key: string): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), AES_IV);
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERS, 32, "sha256").toString("hex");
  return `pbkdf2$${PBKDF2_ITERS}$${salt}$${hash}`;
}

export function passwordNeedsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return true;
  const iterations = Number(parts[1]);
  return !Number.isFinite(iterations) || iterations > PBKDF2_ITERS || iterations < 1;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > PBKDF2_ITERS) return false;
  const salt = parts[2];
  const expected = Buffer.from(parts[3], "hex");
  const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToB64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptText(secret: string, plaintext: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `${bytesToB64(iv)}.${bytesToB64(ct)}`;
}

export async function decryptText(secret: string, packed: string): Promise<string> {
  const [ivB64, ctB64] = packed.split(".");
  if (!ivB64 || !ctB64) throw new Error("密文格式错误");
  const key = await aesKey(secret);
  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ctB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function hmacHex(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text, "utf8").digest("hex");
}

export function hmacEquals(secret: string, text: string, expectedHex: string): boolean {
  if (!/^[0-9a-f]+$/i.test(expectedHex) || expectedHex.length % 2 !== 0) return false;
  const actual = Buffer.from(hmacHex(secret, text), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
