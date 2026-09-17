export type SyncMode = "merge" | "force";

export interface RepositoryTarget {
  repository: string;
  branch?: string;
  syncMode?: SyncMode;
}

export interface SyncOptions {
  dryRun?: boolean;
  repositories?: string[];
  syncMode?: SyncMode;
  revision?: number;
}

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ENCRYPTION_KEY?: string;
  SETUP_TOKEN?: string;
}

export type Database = Pick<D1Database, "prepare" | "batch">;

export interface SyncConfiguration {
  repositories: RepositoryTarget[];
  githubToken: string;
}

export interface SettingsRow {
  id: number;
  password_hash: string;
  github_token: string | null;
  repositories: string;
  sync_enabled: number;
  interval_minutes: number;
  revision: number;
  auth_version: number;
  updated_at: string;
}

export interface SyncStateRow {
  lock_id: string | null;
  lock_until: number;
  last_scheduled_at: number;
  report_json: string | null;
}

export type SyncStatus = "synced" | "up_to_date" | "checked" | "failed" | "skipped";

export interface SyncResult {
  repository: string;
  branch: string | null;
  upstream: string | null;
  status: SyncStatus;
  message: string;
  syncMode: SyncMode;
  upstreamBranch?: string;
  previousSha?: string;
  upstreamSha?: string;
  syncedSha?: string;
  code?: string;
  githubStatus?: number;
  mergeType?: string;
  retryAfter?: string;
}

export interface SyncReport {
  runId: string;
  trigger: "manual" | "scheduled";
  dryRun: boolean;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  summary: Record<SyncStatus, number> & { total: number };
  results: SyncResult[];
}
