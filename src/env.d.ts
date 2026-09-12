// Dashboard / secret bindings. Kept out of wrangler.jsonc `vars` so deploys
// do not overwrite values set in the Cloudflare dashboard.
interface Env {
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  CAP_URL: string;
  CAP_SITE_KEY: string;
  CAP_SECRET_KEY: string;
  EMAIL: SendEmail;
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;
  // 免费 Workers 不能向任意邮箱发信时，用 Resend 兜底（Dashboard Secret）
  RESEND_API_KEY?: string;
  // 未设置或空值时默认关闭歌曲下载（netease-musician-audio）
  LISTEN_AUDIO_ENABLED?: string;
}
