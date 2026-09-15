const API_BASE = "https://api.github.com";
const API_VERSION = "2026-03-10";
export const GITHUB_TIMEOUT_MS = 10_000;

export interface GitHubRepository {
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  default_branch: string;
  parent?: { full_name: string };
}

export interface MergeResponse {
  message: string;
  merge_type: "fast-forward" | "merge" | "none";
  base_branch: string;
}

export class GitHubError extends Error {
  override name = "GitHubError";
  readonly code: string;
  readonly status: number | undefined;
  readonly halt: boolean;
  readonly retryAfter: string | undefined;

  constructor(
    message: string,
    code: string,
    status?: number,
    halt = false,
    retryAfter?: string,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.halt = halt;
    this.retryAfter = retryAfter;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GitHubClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request(path: string, body?: object): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "github-fork-sync-cloudflare-worker",
        "X-GitHub-Api-Version": API_VERSION,
      };
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetch(`${API_BASE}${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
      const raw = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }

      if (!response.ok) {
        const message = (isObject(data) && typeof data.message === "string"
          ? data.message
          : `GitHub 返回 HTTP ${response.status}。`
        ).replaceAll(this.token, "[redacted]").slice(0, 500);
        const rateLimited = response.status === 429 || (response.status === 403 && (
          response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after") || /rate limit|abuse detection/i.test(message)
        ));
        const moved = response.status >= 300 && response.status < 400;
        const code = rateLimited ? "rate_limited"
          : response.status === 401 ? "authentication_failed"
          : response.status === 409 ? "conflict"
          : response.status === 422 ? "validation_failed"
          : response.status === 403 ? "permission_denied"
          : response.status === 404 ? "not_found"
          : moved ? "repository_moved" : "github_error";
        throw new GitHubError(
          moved ? "仓库地址发生跳转，请在设置页面更新仓库名称。" : message,
          code,
          response.status,
          rateLimited || response.status === 401,
          response.headers.get("retry-after") ?? undefined,
        );
      }
      if (!isObject(data)) {
        throw new GitHubError("GitHub 返回了无法识别的响应。", "invalid_response", response.status);
      }
      return data;
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(
        controller.signal.aborted
          ? "GitHub 请求超时；如果已发送同步请求，更新可能已生效，请稍后检查仓库。"
          : "无法连接 GitHub；如果已发送同步请求，更新可能已生效，请稍后检查仓库。",
        controller.signal.aborted ? "timeout" : "network_error",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private repositoryPath(repository: string): string {
    return `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
  }

  async getRepository(repository: string): Promise<GitHubRepository> {
    const data = await this.request(this.repositoryPath(repository));
    if (
      !isObject(data) || typeof data.fork !== "boolean" ||
      typeof data.archived !== "boolean" || typeof data.disabled !== "boolean" ||
      typeof data.default_branch !== "string" || !data.default_branch ||
      (data.fork && (!isObject(data.parent) || typeof data.parent.full_name !== "string"))
    ) {
      throw new GitHubError("GitHub 仓库信息缺少必要字段。", "invalid_response");
    }
    return data as unknown as GitHubRepository;
  }

  async syncFork(repository: string, branch: string): Promise<MergeResponse> {
    const data = await this.request(`${this.repositoryPath(repository)}/merge-upstream`, { branch });
    if (
      !isObject(data) || typeof data.message !== "string" ||
      !["fast-forward", "merge", "none"].includes(String(data.merge_type)) ||
      typeof data.base_branch !== "string"
    ) {
      throw new GitHubError("GitHub 同步响应格式异常，请检查仓库是否已更新。", "invalid_response");
    }
    return data as unknown as MergeResponse;
  }
}
