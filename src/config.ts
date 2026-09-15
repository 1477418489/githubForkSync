import type { RepositoryTarget } from "./types.ts";

export const MAX_REPOSITORIES = 20;
export const SYNC_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
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
    if (Object.keys(entry).some((key) => key !== "repository" && key !== "branch")) {
      throw new ConfigurationError(`${position} 只支持 repository 和 branch 字段。`);
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

    if (entry.branch === undefined) return { repository };
    if (
      typeof entry.branch !== "string" ||
      entry.branch.trim().length === 0 ||
      entry.branch.length > 255 ||
      /[\u0000-\u0020\u007f]/.test(entry.branch)
    ) {
      throw new ConfigurationError(`${position} 的 branch 必须是 1–255 个字符且不含空白的分支名；使用默认分支时请省略该字段。`);
    }
    return { repository, branch: entry.branch };
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
