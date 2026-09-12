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

type EmailFrom = string | { email: string; name: string };

/** Resend 未验证自定义域名时可用的测试发信地址。 */
export const RESEND_DEFAULT_FROM = "onboarding@resend.dev";
const DEFAULT_FROM_NAME = "云村互助";

function senderFrom(env: Env): EmailFrom | null {
  const email = (env.EMAIL_FROM || "").trim();
  if (!email || !isValidEmail(normalizeEmail(email))) return null;
  const name = (env.EMAIL_FROM_NAME || "").trim();
  return name ? { email, name } : email;
}

function fromDisplayName(env: Env): string {
  return (env.EMAIL_FROM_NAME || "").trim() || DEFAULT_FROM_NAME;
}

function resendSenderFrom(env: Env): EmailFrom {
  const email = (env.RESEND_FROM || "").trim();
  const name = fromDisplayName(env);
  if (email && isValidEmail(normalizeEmail(email))) return { email, name };
  return { email: RESEND_DEFAULT_FROM, name };
}

function resendApiKey(env: Env): string {
  return (env.RESEND_API_KEY || "").trim();
}

function hasCloudflareEmail(env: Env): boolean {
  return typeof env.EMAIL?.send === "function";
}

function formatFromAddress(from: EmailFrom): string {
  return typeof from === "string" ? from : `${from.name} <${from.email}>`;
}

export function emailSendConfigured(env: Env): { ok: true } | { ok: false; message: string } {
  const hasCf = hasCloudflareEmail(env);
  const hasResend = Boolean(resendApiKey(env));
  if (!hasCf && !hasResend) {
    return { ok: false, message: "未配置发信：请在 wrangler 中加入 send_email，或设置环境变量 RESEND_API_KEY" };
  }
  if (hasResend) return { ok: true };
  if (!senderFrom(env)) return { ok: false, message: "未配置发信地址 EMAIL_FROM" };
  return { ok: true };
}

function sendErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code || "");
  }
  return "";
}

function isCfArbitrarySendBlocked(error: unknown): boolean {
  const code = sendErrorCode(error);
  if (
    code === "E_RECIPIENT_NOT_ALLOWED" ||
    code === "E_SENDER_NOT_VERIFIED" ||
    code === "E_SENDER_DOMAIN_NOT_AVAILABLE"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /E_RECIPIENT_NOT_ALLOWED|recipient not allowed/i.test(message);
}

export function emailSendErrorMessage(error: unknown): string {
  switch (sendErrorCode(error)) {
    case "E_RECIPIENT_NOT_ALLOWED":
      return "无法向该邮箱发信。免费档只能发给账号里已验证的目标地址；任意邮箱需要 Workers Paid 并开通 Email Sending，或配置 RESEND_API_KEY 使用 Resend。";
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return "发信域名未开通或未验证，请在 Cloudflare Email Sending 完成域名接入，或配置 RESEND_API_KEY 使用 Resend。";
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return "发信次数过多，请稍后再试";
    case "E_RECIPIENT_SUPPRESSED":
      return "该邮箱已被退信或投诉抑制，换一个邮箱再试";
    case "E_VALIDATION_ERROR":
    case "E_FIELD_MISSING":
      return "邮箱地址无效";
    default:
      return error instanceof Error && error.message ? error.message : "发送邮件失败";
  }
}

/** Resend REST API, same as `new Resend(apiKey).emails.send({ from, to, subject, html })`. */
async function sendViaResend(
  env: Env,
  from: EmailFrom,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey(env)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: formatFromAddress(from),
      to: [to],
      subject,
      text,
      html,
    }),
  });
  if (response.ok) return;
  const raw = await response.text();
  let detail = "";
  try {
    const body = JSON.parse(raw) as { message?: unknown };
    if (typeof body.message === "string") detail = body.message.trim();
  } catch {
    detail = raw.trim();
  }
  if (/only send testing emails to your own email address/i.test(detail)) {
    throw new Error(
      "Resend 默认域名 onboarding@resend.dev 只能发给账号自己的邮箱。要发给任意用户，请验证域名并设置 RESEND_FROM。",
    );
  }
  throw new Error(detail || `Resend 发信失败（HTTP ${response.status}）`);
}

async function sendAppEmailViaResend(env: Env, to: string, subject: string, text: string, html: string): Promise<void> {
  try {
    await sendViaResend(env, resendSenderFrom(env), to, subject, text, html);
  } catch (error) {
    throw new Error(error instanceof Error && error.message ? error.message : "发送邮件失败");
  }
}

export async function sendAppEmail(env: Env, to: string, subject: string, text: string, html?: string): Promise<void> {
  const configured = emailSendConfigured(env);
  if (!configured.ok) throw new Error(configured.message);
  const htmlBody = html || text.replaceAll("\n", "<br>");
  const canResend = Boolean(resendApiKey(env));
  const cfFrom = senderFrom(env);

  if (hasCloudflareEmail(env) && cfFrom) {
    try {
      await env.EMAIL.send({
        to,
        from: cfFrom,
        subject,
        text,
        html: htmlBody,
      });
      return;
    } catch (error) {
      if (canResend && isCfArbitrarySendBlocked(error)) {
        console.warn("[email] Cloudflare 无法向任意地址发信，改用 Resend", sendErrorCode(error) || error);
        await sendAppEmailViaResend(env, to, subject, text, htmlBody);
        return;
      }
      throw new Error(emailSendErrorMessage(error));
    }
  }

  await sendAppEmailViaResend(env, to, subject, text, htmlBody);
}

export async function sendBindCodeEmail(env: Env, to: string, code: string): Promise<void> {
  await sendAppEmail(
    env,
    to,
    "云村互助邮箱验证码",
    `你正在绑定云村互助账号邮箱。验证码：${code}\n\n${EMAIL_TTL_SEC / 60} 分钟内有效。如非本人操作，请忽略这封邮件。`,
    `<p>你正在绑定云村互助账号邮箱。</p><p>验证码：<strong style="font-size:20px;letter-spacing:4px">${code}</strong></p><p>${EMAIL_TTL_SEC / 60} 分钟内有效。如非本人操作，请忽略这封邮件。</p>`,
  );
}

export async function sendCookieExpiredEmail(env: Env, to: string, nickname: string): Promise<void> {
  const name = nickname.trim() || "网易云账号";
  await sendAppEmail(
    env,
    to,
    `云村互助：${name} 登录已失效`,
    `你绑定的网易云账号「${name}」登录已失效，互助听歌已暂停。\n\n请打开云村互助，重新扫码、用手机验证码或粘贴 Cookie 登录。`,
    `<p>你绑定的网易云账号「${name}」登录已失效，互助听歌已暂停。</p><p>请打开云村互助，重新扫码、用手机验证码或粘贴 Cookie 登录。</p>`,
  );
}
