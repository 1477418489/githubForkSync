import type { RepositoryTarget, SyncMode, SyncOptions } from "./types.ts";

export const MAX_REPOSITORIES = 20;
export const SYNC_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;
// Workers Free 每次执行最多 50 次外部请求；强制同步包含写入后的回读。
export const MAX_GITHUB_REQUESTS = 50;

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

export function isValidBranch(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "@" &&
    !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") &&
    !value.startsWith("-") && !value.endsWith(".") &&
    value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function validateSyncBudget(targets: RepositoryTarget[]): void {
  const requests = targets.reduce((total, target) => total + (target.syncMode === "force" ? 5 : 2), 0);
  if (requests > MAX_GITHUB_REQUESTS) {
    throw new ConfigurationError(`本次同步最多需要 ${requests} 次 GitHub 请求，超过单轮 ${MAX_GITHUB_REQUESTS} 次限制。请减少所选仓库或强制同步仓库的数量；一轮最多支持 10 个强制同步仓库。`);
  }
}

export function parseSyncOptions(body: Record<string, unknown>): SyncOptions {
  if (Object.keys(body).some((key) => !["dryRun", "repositories", "syncMode", "revision"].includes(key))) {
    throw new ConfigurationError("请求包含不支持的字段。");
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    throw new ConfigurationError("dryRun 必须是布尔值。");
  }
  if (body.syncMode !== undefined && body.syncMode !== "merge" && body.syncMode !== "force") {
    throw new ConfigurationError("syncMode 必须是 merge（保留提交合并）或 force（强制对齐上游）。");
  }
  if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1)) {
    throw new ConfigurationError("revision 必须是有效的配置版本号。");
  }
  let repositories: string[] | undefined;
  if (body.repositories !== undefined) {
    if (!Array.isArray(body.repositories)) throw new ConfigurationError("repositories 必须是已保存仓库名称的数组。");
    repositories = parseRepositories(body.repositories.map((repository) => ({ repository })))
      .map((target) => target.repository);
  }
  return {
    ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun as boolean }),
    ...(body.syncMode === undefined ? {} : { syncMode: body.syncMode as SyncMode }),
    ...(body.revision === undefined ? {} : { revision: body.revision as number }),
    ...(repositories === undefined ? {} : { repositories }),
  };
}

export function parseRepositories(value: unknown, allowEmpty = false): RepositoryTarget[] {
  if (value === undefined || value === null || value === "") {
    throw new ConfigurationError("请在设置页面填写同步仓库。");
  }
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ConfigurationError("仓库列表必须是合法的 JSON 数组。");
    }
  }
  if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0) || raw.length > MAX_REPOSITORIES) {
    throw new ConfigurationError(`仓库列表必须配置 ${allowEmpty ? 0 : 1}–${MAX_REPOSITORIES} 个仓库。`);
  }

  const seen = new Set<string>();
  return raw.map((item: unknown, index) => {
    const position = `仓库列表第 ${index + 1} 项`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ConfigurationError(`${position} 必须是包含 repository 的对象。`);
    }
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !["repository", "branch", "syncMode"].includes(key))) {
      throw new ConfigurationError(`${position} 只支持 repository、branch 和 syncMode 字段。`);
    }
    if (typeof entry.repository !== "string") {
      throw new ConfigurationError(`${position} 缺少 repository。`);
    }
    const repository = entry.repository.trim();
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9._-]{1,100}$/.test(repository) ||
      [".", ".."].includes(repository.split("/")[1] ?? "")
    ) {
      throw new ConfigurationError(`${position} 的 repository 格式应为 owner/repo，不要填写 URL。`);
    }
    const key = repository.toLowerCase();
    if (seen.has(key)) {
      throw new ConfigurationError(`${position} 重复配置了同一个仓库。`);
    }
    seen.add(key);

    if (entry.syncMode !== undefined && entry.syncMode !== "merge" && entry.syncMode !== "force") {
      throw new ConfigurationError(`${position} 的 syncMode 必须是 merge 或 force。`);
    }
    if (entry.branch !== undefined && !isValidBranch(entry.branch)) {
      throw new ConfigurationError(`${position} 的 branch 必须是 1–255 个字符的合法 Git 分支名；使用默认分支时请省略该字段。`);
    }
    return {
      repository,
      ...(entry.branch === undefined ? {} : { branch: entry.branch as string }),
      ...(entry.syncMode === undefined ? {} : { syncMode: entry.syncMode }),
    };
  });
}

export function validateGitHubToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^[\x21-\x7e]{1,512}$/.test(token) || token.startsWith("replace-with-")) {
    throw new ConfigurationError("请在设置页面填写有效的 GitHub Token。");
  }
  return token;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128 || !value.trim()) {
    throw new ConfigurationError("管理密码须为 12–128 个字符，建议使用独立的长密码。");
  }
  return value;
}
