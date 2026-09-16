CREATE TABLE IF NOT EXISTS sync_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  report_json TEXT NOT NULL
);

-- 升级时保留旧版本已有的最近一次报告；重复执行不会复制同一条记录。
INSERT OR IGNORE INTO sync_history(run_id, report_json)
SELECT json_extract(report_json, '$.runId'), report_json
FROM sync_state
WHERE report_json IS NOT NULL;
