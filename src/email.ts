import { hmacEquals, hmacHex } from "./crypto";

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

export const EMAIL_TTL_SEC = 10 * 60;
export const EMAIL_SEND_GAP_SEC = 60;
export const EMAIL_DAILY_LIMIT = 8;
export const EMAIL_MAX_ATTEMPTS = 5;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length >= 6 && email.length <= 254 && EMAIL_RE.test(email);
}

export function randomEmailCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

export function hashEmailCode(secret: string, email: string, code: string): string {
  return hmacHex(secret, `${email}\n${code}`);
}

export function verifyEmailCode(secret: string, email: string, code: string, expectedHex: string): boolean {
  return hmacEquals(secret, `${email}\n${code}`, expectedHex);
}

function senderFrom(env: Env): string | { email: string; name: string } | null {
  const email = (env.EMAIL_FROM || "").trim();
  if (!email || !isValidEmail(normalizeEmail(email))) return null;
  const name = (env.EMAIL_FROM_NAME || "").trim();
  return name ? { email, name } : email;
}

export function emailSendConfigured(env: Env): { ok: true; from: string | { email: string; name: string } } | { ok: false; message: string } {
  if (typeof env.EMAIL?.send !== "function") {
    return { ok: false, message: "未配置邮件绑定，请在 wrangler 中加入 send_email 后重新部署" };
  }
  const from = senderFrom(env);
  if (!from) return { ok: false, message: "未配置发信地址 EMAIL_FROM" };
  return { ok: true, from };
}

function sendErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code || "");
  }
  return "";
}

export function emailSendErrorMessage(error: unknown): string {
  switch (sendErrorCode(error)) {
    case "E_RECIPIENT_NOT_ALLOWED":
      return "无法向该邮箱发信。免费档只能发给账号里已验证的目标地址；任意邮箱需要 Workers Paid 并开通 Email Sending。";
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return "发信域名未开通或未验证，请在 Cloudflare Email Sending 完成域名接入。";
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return "发信次数过多，请稍后再试";
    case "E_RECIPIENT_SUPPRESSED":
      return "该邮箱已被退信或投诉抑制，换一个邮箱再试";
    case "E_VALIDATION_ERROR":
    case "E_FIELD_MISSING":
      return "邮箱地址无效";
    default:
      return error instanceof Error && error.message ? error.message : "发送验证码失败";
  }
}

export async function sendBindCodeEmail(env: Env, to: string, code: string): Promise<void> {
  const configured = emailSendConfigured(env);
  if (!configured.ok) throw new Error(configured.message);
  try {
    await env.EMAIL.send({
      to,
      from: configured.from,
      subject: "云村互助邮箱验证码",
      text: `你正在绑定云村互助账号邮箱。验证码：${code}\n\n${EMAIL_TTL_SEC / 60} 分钟内有效。如非本人操作，请忽略这封邮件。`,
      html: `<p>你正在绑定云村互助账号邮箱。</p><p>验证码：<strong style="font-size:20px;letter-spacing:4px">${code}</strong></p><p>${EMAIL_TTL_SEC / 60} 分钟内有效。如非本人操作，请忽略这封邮件。</p>`,
    });
  } catch (error) {
    throw new Error(emailSendErrorMessage(error));
  }
}
