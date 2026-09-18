-- 扩展同步间隔；重建表以替换旧的枚举 CHECK，完整保留配置和认证版本。
CREATE TABLE app_settings_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  github_token TEXT,
  repositories TEXT NOT NULL DEFAULT '[]',
  sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (sync_enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (
    typeof(interval_minutes) = 'integer' AND interval_minutes BETWEEN 15 AND 10080 AND interval_minutes % 15 = 0
  ),
  revision INTEGER NOT NULL DEFAULT 1,
  auth_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

INSERT INTO app_settings_new (
  id, password_hash, github_token, repositories, sync_enabled, interval_minutes, revision, auth_version, updated_at
)
SELECT id, password_hash, github_token, repositories, sync_enabled, interval_minutes, revision, auth_version, updated_at
FROM app_settings;

DROP TABLE app_settings;
ALTER TABLE app_settings_new RENAME TO app_settings;
