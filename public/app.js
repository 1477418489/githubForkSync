const byId = (id) => document.getElementById(id);
const statusLabels = { pending: "待运行", synced: "已更新", up_to_date: "已是最新", checked: "检查通过", failed: "失败", skipped: "已跳过" };
let busy = false;
let config = null;
let formRevision = null;
let rowNumber = 0;

function notice(message, error = false) {
  const element = byId("notice");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.hidden = !message;
}

function setBusy(value) {
  busy = value;
  for (const input of document.querySelectorAll("button, input, select")) input.disabled = value;
  byId("github-token").disabled = value || byId("clear-token").checked;
  byId("add-repository").disabled = value || byId("repository-editor").children.length >= 20;
  for (const id of ["check", "sync"]) byId(id).disabled = value || !config?.githubTokenConfigured || !config?.repositories.length || Boolean(config?.running);
  byId("workspace").setAttribute("aria-busy", String(value));
}

function showScreen(id) {
  for (const screen of ["loading", "setup", "login", "workspace"]) byId(screen).hidden = screen !== id;
}

function showTab(tab) {
  for (const name of ["overview", "settings"]) {
    byId(name + "-view").hidden = name !== tab;
    byId(name + "-tab").setAttribute("aria-selected", String(name === tab));
  }
}

function clearPrivateState() {
  config = null;
  formRevision = null;
  for (const form of document.querySelectorAll("form")) form.reset();
  byId("repositories").replaceChildren();
  byId("repository-editor").replaceChildren();
  byId("run-json").textContent = "";
  byId("run-summary").textContent = "";
  byId("run-result").hidden = true;
  byId("run-history").replaceChildren();
  byId("history-count").textContent = "";
  byId("history-empty").hidden = false;
  byId("next-sync").textContent = "";
}

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new Error("网络连接中断，请刷新确认操作结果。");
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error("服务返回了非 JSON 响应（HTTP " + response.status + "），请查看 Cloudflare 日志。"); }
  if (response.status === 401 && !byId("workspace").hidden) {
    clearPrivateState();
    showScreen("login");
  }
  if (!response.ok && !Array.isArray(data?.results)) {
    const error = new Error(data?.error || "请求失败（HTTP " + response.status + "）。");
    error.status = response.status;
    throw error;
  }
  return data;
}

function intervalLabel(minutes) {
  return minutes < 60 ? "每 " + minutes + " 分钟" : minutes === 1440 ? "每天" : "每 " + minutes / 60 + " 小时";
}

function renderRepositories(repositories, report = null) {
  const list = byId("repositories");
  list.replaceChildren();
  byId("repo-count").textContent = String(repositories.length);
  if (!repositories.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "还没有同步仓库，请前往设置页面添加。";
    list.append(empty);
    return;
  }
  for (const target of repositories) {
    const previous = report?.results.find((result) => result.repository.toLowerCase() === target.repository.toLowerCase() && (!target.branch || result.branch === target.branch));
    const repository = previous || target;
    const row = byId("repository-template").content.cloneNode(true);
    const link = row.querySelector(".repo-link");
    link.textContent = target.repository;
    link.href = "https://github.com/" + target.repository.split("/").map(encodeURIComponent).join("/");
    row.querySelector(".branch").textContent = repository.branch || "默认分支";
    if (repository.upstream) row.querySelector(".upstream").textContent = "上游 " + repository.upstream;
    const status = Object.hasOwn(statusLabels, repository.status) ? repository.status : "pending";
    const badge = row.querySelector(".badge");
    badge.textContent = statusLabels[status];
    badge.dataset.status = status;
    if (repository.message) {
      const message = row.querySelector(".repo-message");
      message.textContent = repository.message;
      message.hidden = false;
    }
    list.append(row);
  }
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false, timeZoneName: "short" });
}

function reportSummary(report) {
  const s = report.summary;
  return report.dryRun
    ? "检查通过 " + s.checked + " · 失败 " + s.failed + " · 跳过 " + s.skipped
    : "已更新 " + s.synced + " · 已是最新 " + s.up_to_date + " · 失败 " + s.failed + " · 跳过 " + s.skipped;
}

function renderReport(report) {
  byId("run-result").hidden = !report;
  if (!report) { byId("run-json").textContent = ""; return; }
  byId("run-title").textContent = "最近一次" + (report.dryRun ? "配置检查" : "同步") + (report.trigger === "scheduled" ? " · 定时任务" : " · 手动执行");
  byId("run-time").textContent = formatTime(report.finishedAt);
  byId("run-summary").textContent = reportSummary(report);
  byId("run-json").textContent = JSON.stringify(report, null, 2);
}

function renderHistory(reports, limit) {
  const list = byId("run-history");
  list.replaceChildren();
  byId("history-empty").hidden = reports.length > 0;
  byId("history-count").textContent = "已保留 " + reports.length + " / " + limit + " 条";
  for (const report of reports) {
    const entry = document.createElement("details");
    entry.className = "history-entry";
    const heading = document.createElement("summary");
    const kind = report.dryRun ? "配置检查" : report.trigger === "scheduled" ? "自动同步" : "手动同步";
    heading.textContent = formatTime(report.finishedAt) + " · " + kind;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.dataset.status = report.ok ? "synced" : "failed";
    badge.textContent = report.ok ? "成功" : "存在失败或跳过";
    heading.append(badge);
    const summary = document.createElement("p");
    summary.className = "history-stats";
    summary.textContent = reportSummary(report);
    const results = document.createElement("ul");
    results.className = "history-results";
    for (const result of report.results) {
      const item = document.createElement("li");
      item.textContent = result.repository + (result.branch ? "（" + result.branch + "）" : "")
        + " · " + (statusLabels[result.status] || result.status) + "：" + result.message;
      results.append(item);
    }
    entry.append(heading, summary, results);
    list.append(entry);
  }
}

function addRepository(target = {}) {
  if (byId("repository-editor").children.length >= 20) return;
  const row = byId("editor-template").content.cloneNode(true);
  const number = ++rowNumber;
  for (const field of ["repository", "branch"]) {
    const input = row.querySelector('[data-field="' + field + '"]');
    input.id = "editor-" + field + "-" + number;
    input.value = target[field] || "";
    row.querySelector(field === "repository" ? ".editor-repo-label" : ".editor-branch-label").htmlFor = input.id;
  }
  row.querySelector(".remove-repository").addEventListener("click", (event) => {
    event.currentTarget.closest(".editor-row").remove();
    setBusy(busy);
  });
  byId("repository-editor").append(row);
  setBusy(busy);
}

function fillSettings(value) {
  byId("settings-form").reset();
  formRevision = value.revision;
  byId("token-status").textContent = value.githubTokenConfigured ? "已保存" : "未设置";
  byId("github-token").placeholder = value.githubTokenConfigured ? "已保存，留空保留原 Token" : "填写具有目标 Fork 写权限的 Token";
  byId("clear-token-label").hidden = !value.githubTokenConfigured;
  byId("sync-enabled").checked = value.syncEnabled;
  byId("interval-minutes").value = String(value.intervalMinutes);
  byId("repository-editor").replaceChildren();
  for (const repository of value.repositories.length ? value.repositories : [{}]) addRepository(repository);
  byId("settings-updated").textContent = "上次保存：" + new Date(value.updatedAt).toLocaleString("zh-CN", { hour12: false });
}

async function loadConfig(fillForm = true) {
  config = await api("/api/config");
  showScreen("workspace");
  byId("schedule-status").textContent = config.running ? "同步任务正在执行，稍后刷新查看结果" : config.syncEnabled ? "自动同步 · " + intervalLabel(config.intervalMinutes) : "自动同步已暂停";
  byId("next-sync").textContent = config.nextSyncAt
    ? "预计下次同步：" + formatTime(config.nextSyncAt)
    : config.syncEnabled ? "下次同步：完成 Token 和仓库配置后安排" : "下次同步：已暂停";
  renderRepositories(config.repositories, config.lastRun);
  renderReport(config.lastRun);
  renderHistory(config.recentRuns ?? (config.lastRun ? [config.lastRun] : []), config.historyLimit ?? 20);
  if (fillForm) fillSettings(config);
  setBusy(busy);
}

async function boot() {
  setBusy(true);
  showScreen("loading");
  byId("retry").hidden = true;
  notice("");
  try {
    const status = await api("/api/status");
    if (!status.initialized) { showScreen("setup"); return; }
    try {
      await loadConfig();
      showTab(config.githubTokenConfigured && config.repositories.length ? "overview" : "settings");
    } catch (error) {
      if (error.status !== 401) throw error;
      showScreen("login");
    }
  } catch (error) {
    notice(error.message, true);
    byId("loading-text").textContent = "服务尚未就绪，请检查部署结果后重试。";
    byId("retry").hidden = false;
  } finally { setBusy(false); }
}

byId("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  if (byId("setup-password").value !== byId("setup-confirm").value) { notice("两次输入的管理密码不一致。", true); return; }
  setBusy(true);
  notice("正在创建管理员…");
  try {
    await api("/api/setup", { method: "POST", body: { setupToken: byId("setup-token").value.trim(), password: byId("setup-password").value } });
    byId("setup-form").reset();
    await loadConfig();
    showTab("settings");
    notice("管理员已创建。请添加 GitHub Token 和仓库，并按需启用自动同步。");
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  notice("正在登录…");
  try {
    await api("/api/login", { method: "POST", body: { password: byId("login-password").value } });
    byId("login-form").reset();
    await loadConfig();
    showTab(config.githubTokenConfigured && config.repositories.length ? "overview" : "settings");
    notice("");
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});

byId("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const password = byId("new-password").value;
  if (password !== byId("new-password-confirm").value) { notice("两次输入的新密码不一致。", true); return; }
  const repositories = Array.from(byId("repository-editor").children, (row) => {
    const repository = row.querySelector('[data-field="repository"]').value.trim();
    const branch = row.querySelector('[data-field="branch"]').value;
    return { repository, ...(branch ? { branch } : {}) };
  });
  const token = byId("github-token").value.trim();
  const body = {
    repositories, revision: formRevision,
    syncEnabled: byId("sync-enabled").checked,
    intervalMinutes: Number(byId("interval-minutes").value),
    ...(byId("clear-token").checked ? { githubToken: null } : token ? { githubToken: token } : {}),
    ...(password ? { password } : {}),
  };
  setBusy(true);
  notice("正在保存设置…");
  try {
    const saved = await api("/api/config", { method: "PUT", body });
    if (saved.reloginRequired) {
      clearPrivateState();
      showScreen("login");
      notice("设置已保存，管理密码已更改。请使用新密码重新登录。");
    } else {
      await loadConfig();
      notice("设置已保存。自动任务按新的配置执行；检查配置可确认仓库是否可读取。");
    }
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});

async function run(dryRun) {
  if (busy) return;
  setBusy(true);
  notice(dryRun ? "正在检查 Fork 配置，此操作不会写入仓库…" : "正在逐个同步仓库，请保持页面打开…");
  try {
    const report = await api("/api/sync", { method: "POST", body: { dryRun } });
    await loadConfig(false);
    renderReport(report);
    renderRepositories(config.repositories, report);
    notice(report.ok ? dryRun ? "仓库检查通过。此检查不验证写权限、目标分支或合并冲突。" : "本轮同步完成。" : "本轮存在失败或跳过的仓库，请查看结果。", !report.ok);
  } catch (error) {
    notice(error.message + (dryRun ? "" : " 若已提交同步请求，请检查运行记录或 GitHub 仓库确认结果。"), true);
  } finally { setBusy(false); }
}

async function refresh() {
  if (busy) return;
  setBusy(true);
  try { await loadConfig(); notice("配置和运行记录已更新。"); }
  catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

byId("disconnect").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    await api("/api/logout", { method: "POST" });
    clearPrivateState();
    showScreen("login");
    notice("");
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});
byId("clear-token").addEventListener("change", () => {
  if (byId("clear-token").checked) { byId("sync-enabled").checked = false; byId("github-token").value = ""; }
  setBusy(busy);
});
byId("add-repository").addEventListener("click", () => addRepository());
byId("overview-tab").addEventListener("click", () => showTab("overview"));
byId("settings-tab").addEventListener("click", () => showTab("settings"));
byId("check").addEventListener("click", () => run(true));
byId("sync").addEventListener("click", () => run(false));
byId("refresh").addEventListener("click", refresh);
byId("reload-settings").addEventListener("click", refresh);
byId("retry").addEventListener("click", boot);
boot();
