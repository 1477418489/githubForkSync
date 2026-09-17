import { parseRepositories, validateGitHubToken, validateSyncBudget } from "./config.ts";
import { GitHubClient, GitHubError } from "./github.ts";
import type { SyncConfiguration, SyncReport, SyncResult } from "./types.ts";

export async function runSync(
  config: SyncConfiguration,
  trigger: SyncReport["trigger"],
  dryRun = false,
): Promise<SyncReport> {
  // 在任何 GitHub 请求前检查完整配置，避免配置写错时只执行一部分。
  const targets = parseRepositories(config.repositories);
  if (!dryRun) validateSyncBudget(targets);
  const client = new GitHubClient(validateGitHubToken(config.githubToken));
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const results: SyncResult[] = [];
  let halted = false;

  // 顺序处理，控制 GitHub 写请求速率和 Workers 子请求数量。
  for (const target of targets) {
    const result: SyncResult = {
      repository: target.repository,
      branch: target.branch ?? null,
      upstream: null,
      status: "failed",
      message: "",
      syncMode: target.syncMode ?? "merge",
    };
    if (halted) {
      results.push({ ...result, status: "skipped", code: "run_halted", message: "GitHub 认证失败或触发限流，本轮剩余仓库暂停处理。" });
      continue;
    }
    try {
      const repository = await client.getRepository(target.repository);
      result.branch = target.branch ?? repository.default_branch;
      result.upstream = repository.parent?.full_name ?? null;
      if (!repository.fork) {
        throw new GitHubError("该仓库不是 GitHub Fork，无法使用上游同步接口。", "not_a_fork");
      }
      if (repository.archived || repository.disabled) {
        throw new GitHubError("该仓库已归档或被禁用，无法同步。", "repository_readonly");
      }
      if (dryRun) {
        result.status = "checked";
        result.message = "仓库可读取且为有效 Fork；未写入，也未验证分支是否存在、写权限或合并冲突。";
      } else if (result.syncMode === "force") {
        result.upstreamBranch = result.branch;
        // 只读取上游同名分支；分支缺失时失败，不猜测其他分支或创建目标分支。
        result.upstreamSha = await client.getBranchSha(result.upstream!, result.branch);
        result.previousSha = await client.getBranchSha(target.repository, result.branch);
        if (result.previousSha === result.upstreamSha) {
          result.status = "up_to_date";
          result.syncedSha = result.previousSha;
          result.message = "目标分支已与上游同名分支的提交完全一致。";
        } else {
          await client.forceUpdateBranch(target.repository, result.branch, result.upstreamSha);
          result.syncedSha = await client.getBranchSha(target.repository, result.branch);
          if (result.syncedSha !== result.upstreamSha) {
            throw new GitHubError("强制更新后目标分支的提交仍不一致，可能存在并发推送；请检查 GitHub 仓库。", "verification_failed");
          }
          result.status = "synced";
          result.message = "已强制对齐上游同名分支，并核验目标提交；该分支原有的独有提交已被移出分支历史。";
        }
      } else {
        const merge = await client.syncFork(target.repository, result.branch);
        result.status = merge.merge_type === "none" ? "up_to_date" : "synced";
        result.mergeType = merge.merge_type;
        result.upstreamBranch = merge.base_branch.replace(/^[^:]+:/, "");
        result.message = merge.message;
      }
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      result.code = error.code;
      result.message = error.message;
      if (error.code === "conflict" && result.syncMode === "merge") {
        result.message = `上游与 Fork 存在合并冲突，本次未合入上游更新。请先解决冲突；若确认可丢弃 Fork 独有提交，可选择强制同步。GitHub：${error.message}`;
      }
      if (error.status !== undefined) result.githubStatus = error.status;
      if (error.retryAfter !== undefined) result.retryAfter = error.retryAfter;
      halted = error.halt;
    }
    results.push(result);
  }

  const summary: SyncReport["summary"] = {
    total: results.length, synced: 0, up_to_date: 0, checked: 0, failed: 0, skipped: 0,
  };
  for (const result of results) summary[result.status]++;
  return {
    runId, trigger, dryRun,
    ok: summary.failed === 0 && summary.skipped === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary,
    results,
  };
}

export function logReport(report: SyncReport): void {
  console.log(JSON.stringify({ event: "fork_sync", ...report }));
}
