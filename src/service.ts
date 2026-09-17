import { ConfigurationError, parseRepositories, validateSyncBudget } from "./config.ts";
import { decryptToken, requireEncryptionKey } from "./crypto.ts";
import { HttpError } from "./http.ts";
import { database, readSettings, RUN_HISTORY_LIMIT } from "./storage.ts";
import { logReport, runSync } from "./sync.ts";
import type { Env, SyncOptions, SyncReport } from "./types.ts";

export const SYNC_LOCK_MS = 10 * 60 * 1000;

export async function executeSync(env: Env, trigger: SyncReport["trigger"], options: SyncOptions = {}, scheduledAt = Date.now()): Promise<SyncReport | null> {
  const db = database(env);
  const settings = await readSettings(db);
  if (!settings || (trigger === "scheduled" && settings.sync_enabled !== 1)) {
    if (trigger === "scheduled") return null;
    throw new HttpError(409, "请先完成首次设置。");
  }
  if (!settings.github_token) throw new HttpError(409, "请先在设置页面保存 GitHub Token。");
  let repositories = parseRepositories(settings.repositories);
  const dryRun = options.dryRun === true;
  if (options.revision !== undefined && options.revision !== settings.revision) {
    throw new HttpError(409, "配置已被其他页面修改，请刷新后重新选择仓库和同步策略。");
  }
  if (options.repositories !== undefined) {
    const selected = new Set(options.repositories.map((name) => name.toLowerCase()));
    const configured = new Set(repositories.map((target) => target.repository.toLowerCase()));
    if (selected.size === 0 || [...selected].some((name) => !configured.has(name))) {
      throw new HttpError(400, "只能选择已保存的仓库同步，请刷新仓库列表后重试。");
    }
    repositories = repositories.filter((target) => selected.has(target.repository.toLowerCase()));
  }
  if (options.syncMode !== undefined) {
    const syncMode = options.syncMode;
    repositories = repositories.map((target) => ({ ...target, syncMode }));
  }
  if (!dryRun) {
    if (trigger === "manual" && repositories.some((target) => target.syncMode === "force") && options.revision === undefined) {
      throw new HttpError(400, "强制同步必须提供当前配置的 revision，请先刷新配置并确认目标分支。");
    }
    try { validateSyncBudget(repositories); }
    catch (error) {
      if (error instanceof ConfigurationError && trigger === "manual") throw new HttpError(400, error.message);
      throw error;
    }
  }
  const githubToken = await decryptToken(settings.github_token, requireEncryptionKey(env.ENCRYPTION_KEY));
  const now = Date.now();
  const lease = crypto.randomUUID();
  const query = trigger === "scheduled"
    ? db.prepare(`UPDATE sync_state SET lock_id = ?, lock_until = ?, last_scheduled_at = ?
        WHERE id = 1 AND lock_until <= ? AND last_scheduled_at <= ?`).bind(
        lease, now + SYNC_LOCK_MS, scheduledAt, now, scheduledAt - settings.interval_minutes * 60_000)
    : db.prepare("UPDATE sync_state SET lock_id = ?, lock_until = ? WHERE id = 1 AND lock_until <= ?").bind(lease, now + SYNC_LOCK_MS, now);
  const lock = await query.run();
  if (lock.meta.changes !== 1) {
    if (trigger === "scheduled") return null;
    throw new HttpError(409, "已有同步任务正在执行，请稍后刷新。中断任务的锁最多保留 10 分钟。");
  }
  try {
    const report = await runSync({ githubToken, repositories }, trigger, dryRun);
    logReport(report);
    const reportJson = JSON.stringify(report);
    await db.batch([
      db.prepare(`INSERT INTO sync_history(run_id, report_json)
        SELECT ?, ? FROM sync_state WHERE id = 1 AND lock_id = ?`).bind(report.runId, reportJson, lease),
      db.prepare(`DELETE FROM sync_history WHERE id NOT IN
        (SELECT id FROM sync_history ORDER BY id DESC LIMIT ?)`).bind(RUN_HISTORY_LIMIT),
      db.prepare("UPDATE sync_state SET report_json = ?, lock_id = NULL, lock_until = 0 WHERE id = 1 AND lock_id = ?")
        .bind(reportJson, lease),
    ]);
    return report;
  } finally {
    await db.prepare("UPDATE sync_state SET lock_id = NULL, lock_until = 0 WHERE id = 1 AND lock_id = ?").bind(lease).run();
  }
}
