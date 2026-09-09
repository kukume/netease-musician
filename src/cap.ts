import { err } from "./auth";

export type CapResolved = {
  url: string;
  siteKey: string;
  secretKey: string;
};

export type CapPublic = {
  enabled: boolean;
  endpoint: string;
};

function trim(value?: string | null): string {
  return (value || "").trim();
}

export function normalizeCapUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function capWidgetEndpoint(url: string, siteKey: string): string {
  return `${normalizeCapUrl(url)}/${siteKey}/`;
}

export function resolveCap(env: Env): CapResolved | null {
  const url = normalizeCapUrl(env.CAP_URL || "");
  const siteKey = trim(env.CAP_SITE_KEY);
  const secretKey = trim(env.CAP_SECRET_KEY);
  if (!url || !siteKey || !secretKey) return null;
  return { url, siteKey, secretKey };
}

export function publicCapConfig(env: Env): CapPublic {
  const cap = resolveCap(env);
  if (!cap) return { enabled: false, endpoint: "" };
  return { enabled: true, endpoint: capWidgetEndpoint(cap.url, cap.siteKey) };
}

export async function verifyCapToken(env: Env, token?: string): Promise<Response | null> {
  const cap = resolveCap(env);
  if (!cap) return null;
  if (!trim(token)) return err("请先完成验证码", 400);
  let success = false;
  try {
    const res = await fetch(capWidgetEndpoint(cap.url, cap.siteKey) + "siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: cap.secretKey, response: token }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { success?: boolean; error?: string };
    success = !!data.success;
  } catch {
    return err("验证码服务暂时不可用", 400);
  }
  if (!success) return err("验证码校验失败，请重试", 400);
  return null;
}
