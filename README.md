# 云村互助（网易云听歌互助平台）

邀请制的网易云听歌互助平台，跑在 **Cloudflare Workers + D1** 上。用户注册后扫码绑定网易云，系统按账号独立、随机时间听管理员设置的歌单。

## 功能

- 账号注册 / 登录，注册必须邀请码
- 管理员后台：用户管理、邀请码、歌单设置、听歌开关、立即调度
- 扫码登录绑定网易云（weapi 二维码，参考 `netease_logic.py`）
- 定时听歌：Cron **每分钟**扫描到期账号（取播放地址 / startplay / 记下 `report_at`，之后的 cron 再上报 play）
- 歌单详情走网易云 `POST /weapi/v6/playlist/detail`

## 环境要求

- **Node.js 22+**（Wrangler 4 需要）
- Cloudflare 账号（部署时）

## 本地开发

```bash
npm install
copy .dev.vars.example .dev.vars
npm run types
npm run dev
```

默认管理员来自 `.dev.vars`：

- `ADMIN_USERNAME=admin`
- `ADMIN_PASSWORD=changeme123`

打开 `http://localhost:8787`。首次启动会自动创建管理员，并生成一条邀请码（可在后台查看）。

手动触发定时任务：

```text
http://localhost:8787/__scheduled
```

需使用 `wrangler dev --test-scheduled`。`npm run dev` 已打开该开关；也可在后台点「立即调度空闲账号」。

## 部署

Worker 名和 D1 名字都是 `netease-musician`。`wrangler.jsonc` **不用填 `database_id`**：第一次 `wrangler deploy` 会按名字自动建库并绑定。表结构会在第一次访问时自动创建（和 [nodewarden](https://github.com/kukume/nodewarden) 一样）。

密钥：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

也可在 Dashboard 的 Variables 里放非敏感的 `ADMIN_USERNAME`。**不要**把 `CAP_URL` / `CAP_SITE_KEY` 写进 `wrangler.jsonc` 的 `vars`：即便是空字符串，每次部署也会覆盖 Dashboard 里的值。启用 Cap 时在 Dashboard 填写 `CAP_URL`、`CAP_SITE_KEY`，私钥用 `npx wrangler secret put CAP_SECRET_KEY`。本仓库已开启 `keep_vars`，Dashboard 明文变量不会被部署清掉。

### Cap 验证码

登录/注册可接 [Cap Standalone](https://trycap.dev)。只通过环境变量配置，三项都配齐才会启用。

- `CAP_URL`：Cap 实例地址，例如 `https://cap.example.com`
- `CAP_SITE_KEY`：站点公钥
- `CAP_SECRET_KEY`：站点私钥（建议 Secret，不要提交进仓库）

本地写 `.dev.vars`，线上用 Dashboard 或 `wrangler secret put`。

### 邮件（验证码 / Cookie 失效通知）

绑定邮箱和 Cookie 失效通知会走 Cloudflare Email Sending（`send_email` 绑定）。**免费 Workers 只能发给账号里已验证的目标地址**；任意外部邮箱需要 Workers Paid 并开通 Email Sending、接入发信域名。

如果还在免费档，配置 `RESEND_API_KEY` 即可兜底：Cloudflare 因「不能发给任意邮箱」失败时，会改用 [Resend](https://resend.com) 发信。发信地址仍用 `EMAIL_FROM` / `EMAIL_FROM_NAME`（Resend 未验证域名时可用 `onboarding@resend.dev`）。

```bash
npx wrangler secret put RESEND_API_KEY
```

本地写在 `.dev.vars`。不要把 API key 写进 `wrangler.jsonc`。

### 歌曲下载

听歌上报不依赖实际拉音频。`LISTEN_AUDIO_ENABLED` 未设置时默认关闭：不向 `netease-musician-audio` 投递、也不下载播放地址。需要打开时在 Dashboard Variables 或 `.dev.vars` 设为 `1` / `true` / `yes` / `on`。

## 说明

- 每个绑定账号有自己的听歌进度和随机下次开听时间。Cron 每分钟：先给「已经听满一首」的账号上报 `play`（当前时间 ≥ `report_at`），再从到期空闲账号里最多开 6 个新听（取播放地址 → `startplay`，并把 `report_at` 写成现在+歌曲时长）。同一账号有未结束的歌时不会再开下一首。上一分钟如果还在开听或上报，这一分钟直接退出（`work.skip`）。
- 开听任务不等待歌曲时长：到期后由之后的 cron 上报 `play`。两首之间随机间隔约 40–180 秒。
- 拉取播放地址时若网易云返回 HTTP 403/401，或业务码 301/302/401/403，会把该账号标为登录失效，需要用户重新扫码。
- 网易云 Cookie 使用 `SESSION_SECRET` 做 AES-GCM 加密后写入 D1。
- 请只在自己的互助圈子里使用，遵守网易云服务条款。
