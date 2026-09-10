const state = {
  user: null,
  view: "home",
  overview: null,
  logs: [],
  logsPage: 1,
  logsTotal: 0,
  logsTotalPages: 1,
  tracksPage: 1,
  tracksTotal: 0,
  tracksTotalPages: 1,
  admin: {
    users: [],
    usersPage: 1,
    usersTotal: 0,
    usersTotalPages: 1,
    invites: [],
    invitesPage: 1,
    invitesTotal: 0,
    invitesTotalPages: 1,
    logs: [],
    logsPage: 1,
    logsTotal: 0,
    logsTotalPages: 1,
    playlist: null,
    tracks: [],
    tracksPage: 1,
    tracksTotal: 0,
    tracksTotalPages: 1,
  },
  qr: null,
  pollTimer: null,
  statusTimer: null,
  statusBusy: false,
  cap: { enabled: false, endpoint: "" },
};

const DEFAULT_COVER = "/cover-default.svg";
const THEME_KEY = "theme";

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function themeToggleLabel() {
  return currentTheme() === "light" ? "暗色" : "亮色";
}

function bindThemeToggle() {
  const btn = $("#theme-toggle");
  if (!btn) return;
  btn.onclick = () => {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
    btn.textContent = themeToggleLabel();
  };
}

const $ = (sel, el = document) => el.querySelector(sel);
const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

function toast(message, type = "ok") {
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  setTimeout(() => toastEl.classList.add("hidden"), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, message: "请求失败" }));
  if (!res.ok || data.ok === false) throw new Error(data.message || "请求失败");
  return data;
}

function fmtTime(sec) {
  if (!sec) return "尚未听歌";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
}

function fmtRemain(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r} 秒`;
  return `${m} 分 ${r} 秒`;
}

function cronStatusText(cron) {
  if (!cron || !cron.at) return "定时任务尚未运行";
  const age = typeof cron.ageSec === "number" ? cron.ageSec : Math.max(0, Math.floor(Date.now() / 1000) - cron.at);
  const when = age < 5 ? "刚刚" : `${fmtRemain(age)}前`;
  if (cron.status === "error") return `定时任务 ${when}出错${cron.message ? `：${cron.message}` : ""}`;
  if (!cron.healthy) return `定时任务已 ${fmtRemain(age)} 未正常触发，请检查 Cloudflare Cron`;
  if (cron.status === "busy") return `定时任务 ${when}上一轮开听未结束，本轮只做了上报`;
  const extra =
    cron.leftoverStarts || cron.leftoverReports
      ? `，剩余 ${cron.leftoverStarts || 0} 开听 / ${cron.leftoverReports || 0} 上报留给下轮`
      : "";
  return `定时任务 ${when}正常 · 开听 ${cron.started || 0} / 上报 ${cron.reported || 0} · ${cron.wallMs || 0}ms${extra}`;
}

function listenState(a) {
  const now = Math.floor(Date.now() / 1000);
  if (a.status === "expired") return "Cookie 已失效，请重新登录";
  if (a.pendingSongId && a.reportAt > now) {
    return `正在听「${a.pendingSongName || a.pendingSongId}」，约 ${fmtRemain(a.reportAt - now)} 后上报`;
  }
  if (a.pendingSongId && a.reportAt && a.reportAt <= now) {
    return `正在上报「${a.pendingSongName || a.pendingSongId}」`;
  }
  if (a.nextListenAt > now) return `空闲，约 ${fmtTime(a.nextListenAt)} 开听下一首`;
  return a.lastListenAt ? `上次 ${fmtTime(a.lastListenAt)}` : "等待随机开听";
}

function accountAwaitingReport(a) {
  const now = Math.floor(Date.now() / 1000);
  return !!(a.pendingSongId && a.reportAt && a.reportAt <= now);
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function refreshCapWidget() {
  const capEl = $("#cap");
  if (!capEl || typeof capEl.reset !== "function") return;
  capEl.reset();
  if (typeof capEl.solve === "function") {
    Promise.resolve(capEl.solve()).catch(() => {});
  }
}

function coverSrc(src) {
  return src || DEFAULT_COVER;
}

function coverTag(src, cls = "cover") {
  return `<img class="${cls}" src="${escapeHtml(coverSrc(src))}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'" />`;
}

function pager(kind, page, totalPages, total) {
  return `
    <div class="pager">
      <span>第 ${page} / ${totalPages} 页，共 ${total} 条</span>
      <div class="row-actions">
        <button class="btn ghost small" data-page="${kind}:prev" ${page <= 1 ? "disabled" : ""}>上一页</button>
        <button class="btn ghost small" data-page="${kind}:next" ${page >= totalPages ? "disabled" : ""}>下一页</button>
      </div>
    </div>
  `;
}

function render() {
  if (!state.user) {
    stopHomeStatusPoll();
    return renderAuth();
  }
  renderApp();
}

function renderAuth(mode = "login") {
  stopHomeStatusPoll();
  app.innerHTML = `
    <div class="auth-wrap">
      <button class="btn ghost small theme-toggle" id="theme-toggle" type="button">${themeToggleLabel()}</button>
      <div class="auth-card">
        <div class="hero">
          <div class="kicker">Netease Listen Club</div>
          <h1>云村互助<br/>把喜欢的歌听热</h1>
          <p>邀请制社区。绑定网易云后，每个账号会在随机时间独立听歌，同一时间只听一首。</p>
          <div class="vinyl"></div>
        </div>
        <div class="form-side">
          <div class="tabs">
            <button class="tab ${mode === "login" ? "active" : ""}" data-mode="login">登录</button>
            <button class="tab ${mode === "register" ? "active" : ""}" data-mode="register">注册</button>
          </div>
          <form id="auth-form">
            <label>用户名</label>
            <input name="username" autocomplete="username" required placeholder="3-20 位字母数字" />
            <label>密码</label>
            <input name="password" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" required />
            ${
              mode === "register"
                ? `<label>邀请码</label><input name="inviteCode" required placeholder="向管理员索取" />`
                : ""
            }
            ${
              state.cap?.enabled
                ? `<div class="cap-wrap"><cap-widget id="cap" required data-cap-api-endpoint="${escapeHtml(state.cap.endpoint)}" data-cap-lang="zh-cn"></cap-widget></div>`
                : ""
            }
            <button class="btn" type="submit">${mode === "login" ? "进入云村" : "创建账号"}</button>
          </form>
          <div class="hint">首次部署会自动创建管理员账号，默认用户名见 .dev.vars。</div>
        </div>
      </div>
    </div>
  `;
  app.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => renderAuth(btn.dataset.mode)),
  );
  bindThemeToggle();
  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    const capEl = $("#cap");
    if (state.cap?.enabled) {
      const token = body["cap-token"] || capEl?.token || capEl?.tokenValue;
      if (!token) {
        toast("请先完成验证码", "error");
        return;
      }
      body["cap-token"] = token;
    }
    try {
      const data = await api(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        body,
      });
      state.user = data.user;
      await loadHome();
    } catch (err) {
      toast(err.message, "error");
      refreshCapWidget();
    }
  });
}

function renderApp() {
  const isAdmin = state.user.role === "admin";
  const o = state.overview || {};
  const playlist = o.playlist || {};
  const current = o.current || {};
  app.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="brand"><div class="logo-dot">♪</div>云村互助</div>
        <div class="userchip">
          <span>${escapeHtml(state.user.username)} · ${isAdmin ? "管理员" : "成员"}</span>
          <button class="btn ghost small" id="theme-toggle" type="button">${themeToggleLabel()}</button>
          <button class="btn ghost small" id="change-password">修改密码</button>
          <button class="btn ghost small" id="logout">退出</button>
        </div>
      </div>
      <div class="nav">
        <button data-view="home" class="${state.view === "home" ? "active" : ""}">我的听歌</button>
        ${isAdmin ? `<button data-view="admin" class="${state.view === "admin" ? "active" : ""}">管理后台</button>` : ""}
      </div>
      ${state.view === "admin" && isAdmin ? renderAdmin() : renderHome(playlist, current, o)}
    </div>
  `;
  bindThemeToggle();
  $("#change-password").onclick = openPasswordModal;
  $("#logout").onclick = async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    state.cap = await api("/api/cap/widget").catch(() => ({ enabled: false, endpoint: "" }));
    renderAuth();
  };
  app.querySelectorAll(".nav button").forEach((btn) => {
    btn.onclick = async () => {
      state.view = btn.dataset.view;
      if (state.view === "admin") await loadAdmin();
      else await loadHome();
    };
  });
  bindHome();
  bindAdmin();
  if (state.view === "home") startHomeStatusPoll();
  else stopHomeStatusPoll();
}

function renderHome(playlist, current, o) {
  const accounts = o.accounts || [];
  const tracks = o.tracks || [];
  current = current || {};
  return `
    <div class="grid">
      <div class="card">
        <h2>${playlist.name ? escapeHtml(playlist.name) : "等待管理员设置歌单"}</h2>
        <div class="muted">${playlist.listenEnabled === false ? "互助听歌已暂停" : "每 2 分钟扫描到期账号：各自随机开听，跳过自己的歌，听完一首才排下一首。"}</div>
        <div class="muted" data-cron-status>${escapeHtml(cronStatusText(o.cron))}</div>
        <div class="nowplay">
          ${coverTag(current.cover || playlist.cover)}
          <div>
            <div class="muted">${current.name ? "你的账号正在听" : "当前没有你的账号在听"}</div>
            <h3 style="margin:4px 0 0">${escapeHtml(current.name || "等待随机开听")}</h3>
            <div class="muted">${escapeHtml(current.artist || "")}</div>
          </div>
        </div>
        <div class="stats">
          <div class="stat"><span class="muted">歌单曲目</span><b>${playlist.trackCount || 0}</b></div>
          <div class="stat"><span class="muted">已绑定账号</span><b>${o.boundCount || 0}</b></div>
          <div class="stat"><span class="muted">正在听</span><b>${o.listeningCount || 0}</b></div>
        </div>
        <div style="margin-top:18px">
          <div class="muted">歌曲</div>
          ${tracks
            .map((t, i) => {
              const n = ((state.tracksPage || 1) - 1) * 15 + i + 1;
              return `
            <div class="track">
              <span>${String(n).padStart(2, "0")}</span>
              <div><b>${escapeHtml(t.name)}</b><div class="muted">${escapeHtml(t.artist)}</div></div>
            </div>`;
            })
            .join("") || `<div class="muted" style="margin-top:8px">暂无歌曲</div>`}
          ${pager("home-tracks", state.tracksPage || 1, state.tracksTotalPages || 1, state.tracksTotal || 0)}
        </div>
      </div>
      <div>
        <div class="card">
          <h2>网易云账号</h2>
          <div class="muted">每个账号独立听歌，同一时间只会听一首。登录失效后可扫码、手机验证码或粘贴 Cookie 重新登录。</div>
          ${(accounts || [])
            .map(
              (a) => `
            <div class="account" data-account-id="${escapeHtml(a.id)}">
              ${coverTag(a.avatar, "avatar")}
              <div class="grow">
                <div>${escapeHtml(a.nickname || "未命名")} <span data-account-badges>${accountBadges(a)}</span></div>
                <div class="muted" data-listen-status="${escapeHtml(a.id)}">${escapeHtml(listenState(a))}</div>
                ${a.lastError && a.status !== "expired" ? `<div class="muted" data-account-error="${escapeHtml(a.id)}">${escapeHtml(a.lastError)}</div>` : `<div class="muted" data-account-error="${escapeHtml(a.id)}" hidden></div>`}
              </div>
              <button class="btn ghost small" data-unbind="${a.id}">解绑</button>
            </div>`,
            )
            .join("") || `<div class="muted" style="margin-top:12px">还没有绑定账号</div>`}
          <button class="btn" id="bind">${accounts.some((a) => a.status === "expired") ? "重新登录" : accounts.length ? "继续绑定账号" : "绑定网易云"}</button>
        </div>
        <div class="card" style="margin-top:18px">
          <h2>我的听歌记录</h2>
          <div class="logs">
            ${(state.logs || [])
              .map(
                (l) => `
              <div class="logline">
                <span class="badge ${l.ok ? "" : "bad"}">${l.ok ? "成功" : "失败"}</span>
                ${escapeHtml(l.songName || l.songId)} · ${escapeHtml(l.artist || "")}
                <div>${fmtTime(l.createdAt)}</div>
              </div>`,
              )
              .join("") || `<div class="muted">暂无记录</div>`}
          </div>
          ${pager("home-logs", state.logsPage || 1, state.logsTotalPages || 1, state.logsTotal || 0)}
        </div>
      </div>
    </div>
  `;
}

function renderAdmin() {
  const p = state.admin.playlist || {};
  const tracks = state.admin.tracks || [];
  return `
    <div class="card" style="margin-bottom:18px">
      <h2>互助歌单</h2>
      <div class="muted">粘贴网易云歌单链接或 ID。保存后每个绑定账号会按自己的进度、在随机时间听这个歌单。</div>
      <div class="muted" data-cron-status>${escapeHtml(cronStatusText(state.admin.cron))}</div>
      <form id="playlist-form" style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
        <input name="playlist" placeholder="https://music.163.com/playlist?id=..." style="flex:1;min-width:240px" />
        <button class="btn small" type="submit">拉取并保存</button>
        ${p.playlist_id ? `<button class="btn ghost small" id="refresh-playlist" type="button">重新拉取歌单</button>` : ""}
        <button class="btn ghost small" id="toggle-listen" type="button">${p.listen_enabled ? "暂停听歌" : "开启听歌"}</button>
        <button class="btn ghost small" id="run-now" type="button">立即调度空闲账号</button>
        <button class="btn ghost small" id="run-migrate" type="button">${
          (state.admin.migrate?.pending || []).length
            ? `应用数据库迁移（${state.admin.migrate.pending.length}）`
            : "应用数据库迁移"
        }</button>
      </form>
      <div class="nowplay">
        ${coverTag(p.cover)}
        <div>
          <h3 style="margin:0">${escapeHtml(p.name || "未设置")}</h3>
          <div class="muted">${p.track_count || 0} 首 · 最近开听第 ${(p.cursor || 0) + 1} 首</div>
        </div>
      </div>
      <div style="margin-top:12px">
        ${tracks
          .map((t, i) => {
            const n = ((state.admin.tracksPage || 1) - 1) * 15 + i + 1;
            return `<div class="track"><span>${n}</span><div><b>${escapeHtml(t.name)}</b><div class="muted">${escapeHtml(t.artist)}</div></div></div>`;
          })
          .join("") || `<div class="muted">暂无歌曲</div>`}
      </div>
      ${pager("tracks", state.admin.tracksPage, state.admin.tracksTotalPages, state.admin.tracksTotal)}
    </div>
    <div class="grid">
      <div class="card">
        <h2>用户管理</h2>
        <div class="table-wrap">
        <table class="table">
          <thead><tr><th>用户</th><th>角色</th><th class="col-center">状态</th><th>绑定</th><th></th></tr></thead>
          <tbody>
            ${(state.admin.users || [])
              .map(
                (u) => `
              <tr>
                <td>${escapeHtml(u.username)}</td>
                <td>${u.role === "admin" ? "管理员" : "成员"}</td>
                <td class="col-center"><span class="badge ${u.status === "active" ? "" : "bad"}">${u.status === "active" ? "正常" : "停用"}</span></td>
                <td>${u.bound}</td>
                <td class="row-actions">
                  ${
                    u.id === state.user.id
                      ? ""
                      : `
                    <button class="btn ghost small" data-status="${u.id}:${u.status === "active" ? "disabled" : "active"}">${u.status === "active" ? "停用" : "启用"}</button>
                    <button class="btn ghost small" data-del-user="${u.id}">删除</button>`
                  }
                </td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
        </div>
        ${pager("users", state.admin.usersPage, state.admin.usersTotalPages, state.admin.usersTotal)}
      </div>
      <div class="card">
        <h2>邀请码</h2>
        <button class="btn small" id="new-invite">生成邀请码</button>
        <div class="table-wrap">
        <table class="table">
          <thead><tr><th>邀请码</th><th class="col-center">使用</th><th></th></tr></thead>
          <tbody>
            ${(state.admin.invites || [])
              .map(
                (i) => `
              <tr>
                <td><b>${escapeHtml(i.code)}</b></td>
                <td class="col-center">${i.usedBy ? escapeHtml(i.usedBy) : '<span class="badge warn">未使用</span>'}</td>
                <td>${i.usedBy ? "" : `<button class="btn ghost small" data-del-invite="${i.id}">删除</button>`}</td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
        </div>
        ${pager("invites", state.admin.invitesPage, state.admin.invitesTotalPages, state.admin.invitesTotal)}
      </div>
    </div>
    <div class="card" style="margin-top:18px">
      <h2>全站听歌日志</h2>
      <div class="logs">
        ${(state.admin.logs || [])
          .map(
            (l) => `
          <div class="logline">
            <span class="badge ${l.ok ? "" : "bad"}">${l.ok ? "成功" : "失败"}</span>
            ${escapeHtml(l.username || "")} / ${escapeHtml(l.nickname || "")}
            · ${escapeHtml(l.songName || "")}
            <div>${escapeHtml(l.message || "")} · ${fmtTime(l.createdAt)}</div>
          </div>`,
          )
          .join("") || `<div class="muted">暂无记录</div>`}
      </div>
      ${pager("logs", state.admin.logsPage, state.admin.logsTotalPages, state.admin.logsTotal)}
    </div>
  `;
}

function accountBadges(a) {
  const now = Math.floor(Date.now() / 1000);
  if (a.status === "expired") return '<span class="badge bad">登录失效</span>';
  if (a.pendingSongId && a.reportAt > now) return '<span class="badge">听歌中</span>';
  return "";
}

function stopHomeStatusPoll() {
  clearInterval(state.statusTimer);
  state.statusTimer = null;
  state.statusBusy = false;
}

function startHomeStatusPoll() {
  if (state.statusTimer) return;
  let ticks = 0;
  state.statusTimer = setInterval(() => {
    if (document.hidden || state.view !== "home") return;
    const reportDue = tickListenStatus();
    ticks += 1;
    if (reportDue || ticks % 4 === 0) void refreshHomeStatus();
  }, 1000);
}

function tickListenStatus() {
  let reportDue = false;
  for (const a of state.overview?.accounts || []) {
    const row = app.querySelector(`[data-account-id="${CSS.escape(a.id)}"]`);
    if (!row) continue;
    const statusEl = row.querySelector("[data-listen-status]");
    const badgesEl = row.querySelector("[data-account-badges]");
    if (statusEl) statusEl.textContent = listenState(a);
    if (badgesEl) badgesEl.innerHTML = accountBadges(a);
    if (accountAwaitingReport(a)) reportDue = true;
  }
  return reportDue;
}

function homeTracksUrl() {
  return `/api/overview?page=${state.tracksPage || 1}&pageSize=15`;
}

function homeLogsUrl() {
  return `/api/logs?page=${state.logsPage || 1}&pageSize=15`;
}

function applyHomePayload(overview, logs) {
  state.overview = overview;
  state.logs = logs.logs || [];
  state.tracksPage = overview.tracksPage || 1;
  state.tracksTotal = overview.tracksTotal || 0;
  state.tracksTotalPages = overview.tracksTotalPages || 1;
  state.logsPage = logs.page || 1;
  state.logsTotal = logs.total || 0;
  state.logsTotalPages = logs.totalPages || 1;
}

async function refreshHomeStatus() {
  if (state.statusBusy || !state.user || state.view !== "home") return;
  state.statusBusy = true;
  try {
    const [overview, logs] = await Promise.all([api(homeTracksUrl()), api(homeLogsUrl())]);
    if (state.view !== "home") return;
    applyHomePayload(overview, logs);
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  } catch {
    /* keep showing the last known status */
  } finally {
    state.statusBusy = false;
  }
}

function bindHome() {
  const bindBtn = $("#bind");
  if (bindBtn) bindBtn.onclick = openQrModal;
  app.querySelectorAll("[data-unbind]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("确定解绑这个网易云账号？")) return;
      try {
        await api(`/api/netease/accounts/${btn.dataset.unbind}`, { method: "DELETE" });
        toast("已解绑");
        await loadHome();
      } catch (e) {
        toast(e.message, "error");
      }
    };
  });
  app.querySelectorAll("[data-page]").forEach((btn) => {
    btn.onclick = async () => {
      if (btn.disabled) return;
      const [kind, dir] = btn.dataset.page.split(":");
      if (kind === "home-tracks") {
        const next = dir === "next" ? (state.tracksPage || 1) + 1 : (state.tracksPage || 1) - 1;
        if (next < 1 || next > (state.tracksTotalPages || 1)) return;
        state.tracksPage = next;
        await loadHome();
        return;
      }
      if (kind === "home-logs") {
        const next = dir === "next" ? (state.logsPage || 1) + 1 : (state.logsPage || 1) - 1;
        if (next < 1 || next > (state.logsTotalPages || 1)) return;
        state.logsPage = next;
        await loadHome();
      }
    };
  });
}

function bindAdmin() {
  const form = $("#playlist-form");
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const playlist = new FormData(form).get("playlist");
    try {
      const data = await api("/api/admin/playlist", { method: "PUT", body: { playlist } });
      toast(`已保存「${data.name}」，共 ${data.trackCount} 首`);
      state.admin.tracksPage = 1;
      await loadAdmin();
    } catch (err) {
      toast(err.message, "error");
    }
  };
  const refreshBtn = $("#refresh-playlist");
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      const prev = refreshBtn.textContent;
      refreshBtn.disabled = true;
      refreshBtn.textContent = "正在拉取…";
      try {
        const data = await api("/api/admin/playlist/refresh", { method: "POST" });
        toast(`已重新拉取「${data.name}」，共 ${data.trackCount} 首`);
        state.admin.tracksPage = 1;
        await loadAdmin();
      } catch (err) {
        toast(err.message, "error");
        refreshBtn.disabled = false;
        refreshBtn.textContent = prev;
      }
    };
  }
  $("#toggle-listen").onclick = async () => {
    const enabled = !(state.admin.playlist || {}).listen_enabled;
    try {
      await api("/api/admin/listen", { method: "PUT", body: { enabled } });
      await loadAdmin();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  $("#run-now").onclick = async () => {
    const btn = $("#run-now");
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "正在调度…";
    try {
      const data = await api("/api/admin/listen/run", { method: "POST" });
      toast(
        data.skipped ||
          `空闲账号 ${data.scattered || 0} 已排队：本分钟开听 ${data.started || 0}，上报 ${data.reported || 0}`,
      );
      await loadAdmin();
    } catch (e) {
      toast(e.message, "error");
      btn.disabled = false;
      btn.textContent = prev;
    }
  };
  const migrateBtn = $("#run-migrate");
  if (migrateBtn) {
    migrateBtn.onclick = async () => {
      const prev = migrateBtn.textContent;
      migrateBtn.disabled = true;
      migrateBtn.textContent = "正在迁移…";
      try {
        const data = await api("/api/admin/migrate", { method: "POST" });
        const ran = data.ran || [];
        toast(ran.length ? `已应用：${ran.join("、")}` : "没有待应用的迁移");
        await loadAdmin();
      } catch (e) {
        toast(e.message, "error");
        migrateBtn.disabled = false;
        migrateBtn.textContent = prev;
      }
    };
  }
  $("#new-invite").onclick = async () => {
    try {
      const data = await api("/api/admin/invites", { method: "POST", body: { count: 1 } });
      toast(`新邀请码：${data.codes[0]}`);
      state.admin.invitesPage = 1;
      await loadAdmin();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  app.querySelectorAll("[data-status]").forEach((btn) => {
    btn.onclick = () => patchUserStatus(...btn.dataset.status.split(":"));
  });
  app.querySelectorAll("[data-del-user]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("确定删除该用户？")) return;
      try {
        await api(`/api/admin/users/${btn.dataset.delUser}`, { method: "DELETE" });
        await loadAdmin();
      } catch (e) {
        toast(e.message, "error");
      }
    };
  });
  app.querySelectorAll("[data-del-invite]").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/admin/invites/${btn.dataset.delInvite}`, { method: "DELETE" });
      await loadAdmin();
    };
  });
  app.querySelectorAll("[data-page]").forEach((btn) => {
    btn.onclick = async () => {
      if (btn.disabled) return;
      const [kind, dir] = btn.dataset.page.split(":");
      const key = `${kind}Page`;
      const pagesKey = `${kind}TotalPages`;
      const current = state.admin[key] || 1;
      const next = dir === "next" ? current + 1 : current - 1;
      if (next < 1 || next > (state.admin[pagesKey] || 1)) return;
      state.admin[key] = next;
      await loadAdmin();
    };
  });
}

async function patchUserStatus(id, status) {
  await api(`/api/admin/users/${id}`, { method: "PATCH", body: { status } });
  await loadAdmin();
}

function openPasswordModal() {
  const wrap = document.createElement("div");
  wrap.className = "modal-bg";
  wrap.innerHTML = `
    <div class="modal">
      <h2>修改密码</h2>
      <form id="password-form">
        <label>当前密码</label>
        <input name="oldPassword" type="password" autocomplete="current-password" required />
        <label>新密码</label>
        <input name="newPassword" type="password" autocomplete="new-password" minlength="6" required placeholder="至少 6 位" />
        <label>确认新密码</label>
        <input name="confirmPassword" type="password" autocomplete="new-password" minlength="6" required />
        <button class="btn" type="submit">保存</button>
        <button class="btn ghost" type="button" id="close-password">取消</button>
      </form>
    </div>
  `;
  document.body.appendChild(wrap);
  $("#close-password", wrap).onclick = () => wrap.remove();
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) wrap.remove();
  });
  $("#password-form", wrap).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const oldPassword = String(fd.get("oldPassword") || "");
    const newPassword = String(fd.get("newPassword") || "");
    const confirmPassword = String(fd.get("confirmPassword") || "");
    if (newPassword !== confirmPassword) {
      toast("两次输入的新密码不一致", "error");
      return;
    }
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("/api/auth/password", { method: "POST", body: { oldPassword, newPassword } });
      toast("密码已更新");
      wrap.remove();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  };
}

function showBindTab(wrap, name) {
  wrap.querySelectorAll("[data-bind-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bindTab === name);
  });
  wrap.querySelectorAll("[data-bind-panel]").forEach((el) => {
    el.hidden = el.dataset.bindPanel !== name;
  });
}

function openQrModal() {
  const wrap = document.createElement("div");
  wrap.className = "modal-bg";
  wrap.dataset.smsId = "";
  wrap.innerHTML = `
    <div class="modal">
      <h2>绑定网易云</h2>
      <div class="tabs">
        <button type="button" class="tab active" data-bind-tab="qr">扫码</button>
        <button type="button" class="tab" data-bind-tab="sms">手机验证码</button>
        <button type="button" class="tab" data-bind-tab="cookie">Cookie</button>
      </div>
      <div data-bind-panel="qr">
        <div class="muted" id="qr-status">正在生成二维码…</div>
        <div id="qr-section">
          <div class="qr-box" id="qr-box"></div>
          <div class="qr-url" id="qr-url"></div>
        </div>
      </div>
      <div data-bind-panel="sms" hidden>
        <label for="sms-phone">手机号</label>
        <div class="sms-row">
          <input id="sms-phone" inputmode="tel" autocomplete="tel" placeholder="11 位手机号">
          <button type="button" class="btn small ghost" id="sms-send">发送验证码</button>
        </div>
        <label for="sms-code">验证码</label>
        <input id="sms-code" inputmode="numeric" autocomplete="one-time-code" placeholder="短信验证码">
        <button type="button" class="btn" id="sms-login">登录并绑定</button>
      </div>
      <div data-bind-panel="cookie" hidden>
        <label for="cookie-input">从浏览器复制登录后的 Cookie（需含 MUSIC_U 和 __csrf）</label>
        <textarea id="cookie-input" rows="4" placeholder="MUSIC_U=...; __csrf=..."></textarea>
        <button class="btn" id="bind-cookie">用 Cookie 绑定</button>
      </div>
      <button class="btn ghost" id="close-qr">关闭</button>
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.querySelectorAll("[data-bind-tab]").forEach((btn) => {
    btn.onclick = () => showBindTab(wrap, btn.dataset.bindTab);
  });
  $("#close-qr", wrap).onclick = () => {
    clearInterval(state.pollTimer);
    wrap.remove();
  };
  $("#bind-cookie", wrap).onclick = () => bindWithCookie(wrap);
  $("#sms-send", wrap).onclick = () => sendSmsCodeUi(wrap);
  $("#sms-login", wrap).onclick = () => bindWithSms(wrap);
  $("#sms-phone", wrap).onkeydown = (e) => {
    if (e.key === "Enter") sendSmsCodeUi(wrap);
  };
  $("#sms-code", wrap).onkeydown = (e) => {
    if (e.key === "Enter") bindWithSms(wrap);
  };
  startQr(wrap);
}

async function bindWithCookie(wrap) {
  const btn = $("#bind-cookie", wrap);
  const cookie = ($("#cookie-input", wrap).value || "").trim();
  if (!cookie) {
    toast("请粘贴 Cookie", "error");
    return;
  }
  btn.disabled = true;
  try {
    await api("/api/netease/cookie", { method: "POST", body: { cookie } });
    clearInterval(state.pollTimer);
    toast("绑定成功");
    wrap.remove();
    await loadHome();
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
  }
}

function startSmsCountdown(wrap, seconds) {
  const btn = $("#sms-send", wrap);
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `${left}s`;
  const timer = setInterval(() => {
    left -= 1;
    if (!wrap.isConnected || left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = "发送验证码";
      return;
    }
    btn.textContent = `${left}s`;
  }, 1000);
}

async function sendSmsCodeUi(wrap) {
  const phone = ($("#sms-phone", wrap).value || "").trim();
  if (!phone) {
    toast("请输入手机号", "error");
    return;
  }
  const btn = $("#sms-send", wrap);
  btn.disabled = true;
  try {
    const data = await api("/api/netease/sms/send", { method: "POST", body: { phone } });
    wrap.dataset.smsId = data.id || "";
    toast("验证码已发送");
    startSmsCountdown(wrap, data.retryAfter || 60);
    $("#sms-code", wrap).focus();
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
    btn.textContent = "发送验证码";
  }
}

async function bindWithSms(wrap) {
  const btn = $("#sms-login", wrap);
  const captcha = ($("#sms-code", wrap).value || "").trim();
  const id = wrap.dataset.smsId || "";
  if (!id) {
    toast("请先发送验证码", "error");
    return;
  }
  if (!captcha) {
    toast("请输入验证码", "error");
    return;
  }
  btn.disabled = true;
  try {
    await api("/api/netease/sms/login", { method: "POST", body: { id, captcha } });
    clearInterval(state.pollTimer);
    toast("绑定成功");
    wrap.remove();
    await loadHome();
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
  }
}

function stopQrScan(wrap, message) {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  const status = $("#qr-status", wrap);
  if (status) status.textContent = `${message}。请改用手机验证码或 Cookie`;
  const active = wrap.querySelector("[data-bind-tab].active");
  if (!active || active.dataset.bindTab === "qr") showBindTab(wrap, "sms");
  const phone = $("#sms-phone", wrap);
  if (phone) phone.focus();
  toast(message, "error");
}

async function startQr(wrap) {
  try {
    const data = await api("/api/netease/qrcode", { method: "POST" });
    state.qr = data;
    const box = $("#qr-box", wrap);
    if (data.qrSvg) box.innerHTML = data.qrSvg;
    $("#qr-url", wrap).textContent = data.url || "";
    $("#qr-status", wrap).textContent = "请用网易云 App 扫码并确认登录";
    let checking = false;
    state.pollTimer = setInterval(async () => {
      if (checking || !wrap.isConnected) return;
      checking = true;
      try {
        const st = await api(`/api/netease/qrcode/${data.id}`);
        if (!wrap.isConnected) return;
        if (st.status === "ok") {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
          toast("绑定成功");
          wrap.remove();
          await loadHome();
          return;
        }
        if (st.status === "expired" || st.status === "error" || st.status === "verify") {
          stopQrScan(wrap, st.message || "扫码失败");
          return;
        }
        $("#qr-status", wrap).textContent = st.message || st.status;
      } catch (e) {
        if (wrap.isConnected) stopQrScan(wrap, e.message);
      } finally {
        checking = false;
      }
    }, 1500);
  } catch (e) {
    stopQrScan(wrap, e.message);
  }
}

async function loadHome() {
  state.view = "home";
  const [overview, logs] = await Promise.all([api(homeTracksUrl()), api(homeLogsUrl())]);
  applyHomePayload(overview, logs);
  render();
}

async function loadAdmin() {
  state.view = "admin";
  const [users, invites, playlist, logs, migrate] = await Promise.all([
    api(`/api/admin/users?page=${state.admin.usersPage || 1}&pageSize=15`),
    api(`/api/admin/invites?page=${state.admin.invitesPage || 1}&pageSize=15`),
    api(`/api/admin/playlist?page=${state.admin.tracksPage || 1}&pageSize=15`),
    api(`/api/admin/logs?page=${state.admin.logsPage || 1}&pageSize=15`),
    api("/api/admin/migrate"),
  ]);
  state.admin = {
    ...state.admin,
    users: users.users || [],
    usersPage: users.page || 1,
    usersTotal: users.total || 0,
    usersTotalPages: users.totalPages || 1,
    invites: invites.invites || [],
    invitesPage: invites.page || 1,
    invitesTotal: invites.total || 0,
    invitesTotalPages: invites.totalPages || 1,
    logs: logs.logs || [],
    logsPage: logs.page || 1,
    logsTotal: logs.total || 0,
    logsTotalPages: logs.totalPages || 1,
    playlist: playlist.playlist,
    cron: playlist.cron,
    migrate: { applied: migrate.applied || [], pending: migrate.pending || [] },
    tracks: playlist.tracks || [],
    tracksPage: playlist.page || 1,
    tracksTotal: playlist.total || 0,
    tracksTotalPages: playlist.totalPages || 1,
  };
  render();
}

async function boot() {
  try {
    state.cap = await api("/api/cap/widget").catch(() => ({ enabled: false, endpoint: "" }));
    const data = await api("/api/me");
    state.user = data.user;
    await loadHome();
  } catch {
    state.cap = state.cap || { enabled: false, endpoint: "" };
    renderAuth();
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.user && state.view === "home") void refreshHomeStatus();
});

boot();
