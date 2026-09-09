const state = {
  user: null,
  view: "home",
  overview: null,
  logs: [],
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

function listenState(a) {
  const now = Math.floor(Date.now() / 1000);
  if (a.status === "expired") return "Cookie 已失效，请重新扫码";
  if (a.pendingSongId && a.reportAt > now) {
    return `正在听「${a.pendingSongName || a.pendingSongId}」，约 ${fmtRemain(a.reportAt - now)} 后上报`;
  }
  if (a.nextListenAt > now) return `空闲，约 ${fmtTime(a.nextListenAt)} 开听下一首`;
  return a.lastListenAt ? `上次 ${fmtTime(a.lastListenAt)}` : "等待随机开听";
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
  if (!state.user) return renderAuth();
  renderApp();
}

function renderAuth(mode = "login") {
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
}

function renderHome(playlist, current, o) {
  const accounts = o.accounts || [];
  const tracks = o.tracks || [];
  current = current || {};
  return `
    <div class="grid">
      <div class="card">
        <h2>${playlist.name ? escapeHtml(playlist.name) : "等待管理员设置歌单"}</h2>
        <div class="muted">${playlist.listenEnabled === false ? "互助听歌已暂停" : "每分钟扫描到期账号：各自随机开听，听完一首才排下一首。"}</div>
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
          ${tracks
            .map(
              (t, i) => `
            <div class="track">
              <span>${String(i + 1).padStart(2, "0")}</span>
              <div><b>${escapeHtml(t.name)}</b><div class="muted">${escapeHtml(t.artist)}</div></div>
            </div>`,
            )
            .join("")}
        </div>
      </div>
      <div>
        <div class="card">
          <h2>网易云账号</h2>
          <div class="muted">每个账号独立听歌，同一时间只会听一首。登录失效后需重新扫码。</div>
          ${(accounts || [])
            .map(
              (a) => `
            <div class="account">
              ${coverTag(a.avatar, "avatar")}
              <div class="grow">
                <div>${escapeHtml(a.nickname || "未命名")} ${a.status === "expired" ? '<span class="badge bad">登录失效</span>' : a.pendingSongId ? '<span class="badge">听歌中</span>' : ""}</div>
                <div class="muted">${escapeHtml(listenState(a))}</div>
                ${a.lastError && a.status !== "expired" ? `<div class="muted">${escapeHtml(a.lastError)}</div>` : ""}
              </div>
              <button class="btn ghost small" data-unbind="${a.id}">解绑</button>
            </div>`,
            )
            .join("") || `<div class="muted" style="margin-top:12px">还没有绑定账号</div>`}
          <button class="btn" id="bind">${accounts.some((a) => a.status === "expired") ? "重新扫码登录" : accounts.length ? "继续绑定账号" : "扫码绑定网易云"}</button>
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
      <form id="playlist-form" style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
        <input name="playlist" placeholder="https://music.163.com/playlist?id=..." style="flex:1;min-width:240px" />
        <button class="btn small" type="submit">拉取并保存</button>
        <button class="btn ghost small" id="toggle-listen" type="button">${p.listen_enabled ? "暂停听歌" : "开启听歌"}</button>
        <button class="btn ghost small" id="run-now" type="button">立即调度空闲账号</button>
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

function openQrModal() {
  const wrap = document.createElement("div");
  wrap.className = "modal-bg";
  wrap.innerHTML = `
    <div class="modal">
      <h2>扫码绑定网易云</h2>
      <div class="muted" id="qr-status">正在生成二维码…</div>
      <div class="qr-box" id="qr-box"></div>
      <div class="qr-url" id="qr-url"></div>
      <button class="btn ghost" id="close-qr">关闭</button>
    </div>
  `;
  document.body.appendChild(wrap);
  $("#close-qr", wrap).onclick = () => {
    clearInterval(state.pollTimer);
    wrap.remove();
  };
  startQr(wrap);
}

async function startQr(wrap) {
  try {
    const data = await api("/api/netease/qrcode", { method: "POST" });
    state.qr = data;
    const box = $("#qr-box", wrap);
    if (data.qrSvg) box.innerHTML = data.qrSvg;
    $("#qr-url", wrap).textContent = data.url || "";
    $("#qr-status", wrap).textContent = "请用网易云 App 扫码并确认登录";
    state.pollTimer = setInterval(async () => {
      try {
        const st = await api(`/api/netease/qrcode/${data.id}`);
        $("#qr-status", wrap).textContent = st.message || st.status;
        if (st.status === "ok") {
          clearInterval(state.pollTimer);
          toast("绑定成功");
          wrap.remove();
          await loadHome();
        }
        if (st.status === "expired") {
          clearInterval(state.pollTimer);
          $("#qr-status", wrap).textContent = "二维码已过期，请关闭后重试";
        }
      } catch (e) {
        clearInterval(state.pollTimer);
        toast(e.message, "error");
      }
    }, 1500);
  } catch (e) {
    $("#qr-status", wrap).textContent = e.message;
  }
}

async function loadHome() {
  state.view = "home";
  const [overview, logs] = await Promise.all([api("/api/overview"), api("/api/logs")]);
  state.overview = overview;
  state.logs = logs.logs || [];
  render();
}

async function loadAdmin() {
  state.view = "admin";
  const [users, invites, playlist, logs] = await Promise.all([
    api(`/api/admin/users?page=${state.admin.usersPage || 1}&pageSize=15`),
    api(`/api/admin/invites?page=${state.admin.invitesPage || 1}&pageSize=15`),
    api(`/api/admin/playlist?page=${state.admin.tracksPage || 1}&pageSize=15`),
    api(`/api/admin/logs?page=${state.admin.logsPage || 1}&pageSize=15`),
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

boot();
