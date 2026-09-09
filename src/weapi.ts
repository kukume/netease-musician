import { randomBytes } from "node:crypto";
import { aesCbcBase64 } from "./crypto";

const PRESET_KEY = "0CoJUm6Qyw8W8jud";
const RSA_EXPONENT = 0x010001n;
const RSA_MODULUS = BigInt(
  "0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725" +
    "152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312" +
    "ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424" +
    "d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7",
);

const SECRET_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomSecret(n = 16): string {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += SECRET_CHARS[bytes[i] % SECRET_CHARS.length];
  return out;
}

function rsaEncrypt(text: string): string {
  const reversed = [...text].reverse().join("");
  const hex = Buffer.from(reversed, "utf8").toString("hex");
  const message = BigInt("0x" + hex);
  const encrypted = modPow(message, RSA_EXPONENT, RSA_MODULUS);
  return encrypted.toString(16).padStart(256, "0");
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export function weapiEncrypt(payload: Record<string, unknown>): { params: string; encSecKey: string } {
  const text = JSON.stringify(payload);
  const secret = randomSecret(16);
  const params = aesCbcBase64(aesCbcBase64(text, PRESET_KEY), secret);
  return { params, encSecKey: rsaEncrypt(secret) };
}
