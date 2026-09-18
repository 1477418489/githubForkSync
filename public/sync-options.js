export function intervalLabel(minutes) {
  if (minutes === 10080) return "每周";
  if (minutes % 1440 === 0) return minutes === 1440 ? "每天" : "每 " + minutes / 1440 + " 天";
  if (minutes % 60 === 0) return "每 " + minutes / 60 + " 小时";
  return "每 " + minutes + " 分钟";
}

// 按仓库查找最近一次实际同步；配置检查不能把尚未重试的失败覆盖掉。
export function retryableRepositories(repositories, reports) {
  const results = reports.filter((report) => !report.dryRun).flatMap((report) => report.results);
  return repositories.filter((target) => {
    const latest = results.find((result) => result.repository.toLowerCase() === target.repository.toLowerCase()
      && (!target.branch || result.branch === target.branch));
    return latest?.status === "failed" || latest?.status === "skipped";
  });
}
