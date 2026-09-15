import assert from "node:assert/strict";
import { encryptToken, hashPassword, sha256 } from "../src/crypto.ts";
import { TestDatabase } from "./database.mjs";

export const GITHUB_TOKEN = "test-github-" + "b".repeat(40);
export const PASSWORD = "test-password-for-fork-sync";
export const ENCRYPTION_KEY = "1".repeat(64);
export const SETUP_TOKEN = "2".repeat(64);
export const SESSION_TOKEN = "3".repeat(64);
export const COOKIE = "fork_sync_session=" + SESSION_TOKEN;
let fixtureHash;

export function configuration(overrides = {}) {
  return {
    githubToken: GITHUB_TOKEN,
    repositories: [{ repository: "alice/project" }],
    ...overrides,
  };
}

export async function environment(t, { initialized = true, configured = true, migrate = true, syncEnabled = true, intervalMinutes = 60, repositories = [{ repository: "alice/project" }], overrides = {} } = {}) {
  const db = new TestDatabase({ migrate });
  t.after(() => db.close());
  if (initialized && migrate) {
    fixtureHash ??= hashPassword(PASSWORD);
    db.native.prepare(`INSERT INTO app_settings(id, password_hash, github_token, repositories, sync_enabled, interval_minutes, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)`).run(
      await fixtureHash, configured ? await encryptToken(GITHUB_TOKEN, ENCRYPTION_KEY) : null,
      JSON.stringify(configured ? repositories : []), configured && syncEnabled ? 1 : 0, intervalMinutes, new Date().toISOString(),
    );
    db.native.prepare("INSERT INTO sessions(token_hash, auth_version, expires_at) VALUES (?, 1, ?)").run(await sha256(SESSION_TOKEN), Date.now() + 3_600_000);
  }
  return { DB: db, ENCRYPTION_KEY, SETUP_TOKEN, ASSETS: { fetch: async () => new Response("static asset") }, ...overrides };
}

export function repository(overrides = {}) {
  return {
    fork: true,
    archived: false,
    disabled: false,
    default_branch: "main",
    parent: { full_name: "upstream/project" },
    ...overrides,
  };
}

export function merged(merge_type = "fast-forward") {
  return { message: "Synced with upstream", merge_type, base_branch: "upstream:main" };
}

export function stubGitHub(t, responses) {
  let index = 0;
  return t.mock.method(globalThis, "fetch", async () => {
    assert.ok(index < responses.length, "Unexpected GitHub request");
    const item = responses[index++];
    if (item instanceof Error) throw item;
    if (item instanceof Response) return item;
    return Response.json(item);
  });
}

export function authorizedRequest(path = "/api/sync", options = {}) {
  return new Request(`https://fork-sync.example${path}`, {
    method: path === "/api/sync" ? "POST" : "GET",
    ...options,
    headers: { Cookie: COOKIE, ...options.headers },
  });
}

export function jsonRequest(body, options = {}) {
  return authorizedRequest("/api/sync", {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify(body),
  });
}
