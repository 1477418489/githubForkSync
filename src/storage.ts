import { ConfigurationError, MAX_REPOSITORIES, parseRepositories, SYNC_INTERVALS, validateGitHubToken, validatePassword, validateSyncBudget } from "./config.ts";
import { encryptToken, hashPassword, requireEncryptionKey } from "./crypto.ts";
import { allowFields, HttpError } from "./http.ts";
import type { Database, Env, SettingsRow, SyncReport, SyncStateRow } from "./types.ts";

export const RUN_HISTORY_LIMIT = 20;
const CRON_INTERVAL_MS = 15 * 60_000;

export function database(env: Env): Database {
  if (!env.DB) throw new ConfigurationError("缺少 D1 数据库绑定，请先运行 npm run deploy。");
  // 每个请求先读取主库，避免密码变更或退出登录后读取到旧的授权状态。
  return env.DB.withSession("first-primary");
}

export async function readSettings(db: Database): Promise<SettingsRow | null> {
  try {
    return await db.prepare("SELECT * FROM app_settings WHERE id = 1").first<SettingsRow>();
  } catch {
    throw new ConfigurationError("D1 数据库尚未初始化或暂时不可用，请检查部署日志和数据库迁移。");
  }
}

export async function publicSettings(db: Database, row?: SettingsRow) {
  const settings = row ?? await readSettings(db);
  if (!settings) throw new HttpError(409, "请先完成首次设置。");
  const state = await db.prepare("SELECT * FROM sync_state WHERE id = 1").first<SyncStateRow>();
  if (!state) throw new ConfigurationError("数据库缺少同步状态，请检查迁移是否完成。");
  const repositories = parseRepositories(settings.repositories, true);
  const history = await db.prepare("SELECT report_json FROM sync_history ORDER BY id DESC LIMIT ?")
    .bind(RUN_HISTORY_LIMIT).all<{ report_json: string }>();
  const now = Date.now();
  // 与 */15 Cron 对齐；手动运行不改变 last_scheduled_at。实际执行仍可能受调度延迟和同步锁影响。
  const nextSyncAt = settings.sync_enabled === 1 && settings.github_token && repositories.length > 0
    ? new Date(Math.ceil(Math.max(now + 1, state.last_scheduled_at + settings.interval_minutes * 60_000)
      / CRON_INTERVAL_MS) * CRON_INTERVAL_MS).toISOString()
    : null;
  return {
    repositories,
    githubTokenConfigured: settings.github_token !== null,
    syncEnabled: settings.sync_enabled === 1,
    intervalMinutes: settings.interval_minutes,
    revision: settings.revision,
    updatedAt: settings.updated_at,
    maxRepositories: MAX_REPOSITORIES,
    intervals: SYNC_INTERVALS,
    running: state.lock_until > now,
    nextSyncAt,
    historyLimit: RUN_HISTORY_LIMIT,
    recentRuns: history.results.map((row) => JSON.parse(row.report_json) as SyncReport),
    lastRun: state.report_json ? JSON.parse(state.report_json) : null,
  };
}

export async function saveSettings(db: Database, env: Env, body: Record<string, unknown>) {
  allowFields(body, ["repositories", "githubToken", "syncEnabled", "intervalMinutes", "revision", "password"]);
  const previous = await readSettings(db);
  if (!previous) throw new HttpError(409, "请先完成首次设置。");
  if (!Number.isSafeInteger(body.revision) || body.revision !== previous.revision) {
    throw new HttpError(409, "配置已被其他页面修改，请刷新后重试。");
  }
  if (typeof body.syncEnabled !== "boolean" || !SYNC_INTERVALS.some((minutes) => minutes === body.intervalMinutes)) {
    throw new HttpError(400, "请选择有效的同步开关和同步间隔。");
  }
  let repositories;
  let newToken: string | null | undefined;
  let password: string | undefined;
  try {
    repositories = parseRepositories(body.repositories, !body.syncEnabled);
    if (body.syncEnabled) validateSyncBudget(repositories);
    if (body.githubToken === null) newToken = null;
    else if (body.githubToken !== undefined && body.githubToken !== "") newToken = validateGitHubToken(body.githubToken);
    if (body.password !== undefined) password = validatePassword(body.password);
  } catch (error) {
    if (error instanceof ConfigurationError) throw new HttpError(400, error.message);
    throw error;
  }
  const token = newToken === undefined ? previous.github_token : newToken === null
    ? null : await encryptToken(newToken, requireEncryptionKey(env.ENCRYPTION_KEY));
  if (body.syncEnabled && !token) throw new HttpError(400, "启用自动同步前，请先填写 GitHub Token。");
  const passwordHash = password === undefined ? previous.password_hash : await hashPassword(password);
  const updatedAt = new Date().toISOString();
  const result = await db.prepare(`UPDATE app_settings SET github_token = ?, repositories = ?, sync_enabled = ?,
    interval_minutes = ?, password_hash = ?, auth_version = ?, revision = revision + 1, updated_at = ?
    WHERE id = 1 AND revision = ?`).bind(
    token, JSON.stringify(repositories), body.syncEnabled ? 1 : 0, body.intervalMinutes,
    passwordHash, previous.auth_version + (password === undefined ? 0 : 1), updatedAt, previous.revision,
  ).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "配置已被其他页面修改，请刷新后重试。");
  return { ...(await publicSettings(db)), reloginRequired: password !== undefined };
}
