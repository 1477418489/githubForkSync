import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { TestDatabase } from "./database.mjs";
import { authorizedRequest, branchRef, environment, jsonRequest, merged, repository, stubGitHub } from "./helpers.mjs";

const saveRequest = (body) => authorizedRequest("/api/config", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const settings = (overrides = {}) => ({
  revision: 1, repositories: [{ repository: "alice/project" }], syncEnabled: true, intervalMinutes: 60, ...overrides,
});
const config = async (env) => (await worker.fetch(authorizedRequest("/api/config"), env)).json();

describe("per-repository automatic synchronization", () => {
  it("persists the switch, skips manual-only repositories in Cron and still allows manual runs and checks", async (t) => {
    t.mock.method(console, "log", () => {});
    const env = await environment(t);
    const repositories = [{ repository: "alice/project", autoSync: false }, { repository: "alice/automatic" }];
    const saved = await worker.fetch(saveRequest(settings({ repositories })), env);
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).repositories, repositories);
    const fetch = stubGitHub(t, [repository(), merged(), repository(), merged(), repository(), merged(), repository(), repository()]);
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    const afterCron = await config(env);
    assert.deepEqual(afterCron.lastRun.results.map((result) => result.repository), ["alice/automatic"]);
    assert.equal(afterCron.lastRun.summary.skipped, 0);
    assert.ok(fetch.mock.calls.every(({ arguments: [url] }) => url.includes("/alice/automatic")));
    const manual = await worker.fetch(jsonRequest({}), env);
    assert.equal(manual.status, 200);
    assert.deepEqual((await manual.json()).results.map((result) => result.repository), repositories.map((target) => target.repository));
    const check = await worker.fetch(jsonRequest({ dryRun: true }), env);
    assert.equal(check.status, 200);
    assert.equal((await check.json()).summary.checked, 2);
    assert.equal(fetch.mock.callCount(), 8);
    assert.deepEqual((await config(env)).repositories, repositories);
  });

  it("budgets only automatic repositories for Cron and still checks the full manual scope", async (t) => {
    t.mock.method(console, "log", () => {});
    const env = await environment(t);
    const repositories = Array.from({ length: 11 }, (_, index) => ({
      repository: "alice/repo" + index, syncMode: "force", ...(index === 10 ? { autoSync: false } : {}),
    }));
    const saved = await worker.fetch(saveRequest(settings({ repositories })), env);
    assert.equal(saved.status, 200);
    const fetch = stubGitHub(t, repositories.slice(0, 10).flatMap(() => [repository(), branchRef(), branchRef()]));
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    assert.equal((await config(env)).lastRun.summary.total, 10);
    assert.equal(fetch.mock.callCount(), 30);
    assert.ok(fetch.mock.calls.every(({ arguments: [url] }) => !url.includes("/alice/repo10")));
    assert.equal((await worker.fetch(jsonRequest({ revision: 2 }), env)).status, 400);
    repositories[10].autoSync = true;
    assert.equal((await worker.fetch(saveRequest(settings({ revision: 2, repositories })), env)).status, 400);
    assert.equal(fetch.mock.callCount(), 30);
    assert.equal((await config(env)).revision, 2);
  });

  it("rejects enabling an empty automatic scope and makes no changes on invalid switches", async (t) => {
    const env = await environment(t);
    const before = { ...env.DB.native.prepare("SELECT * FROM app_settings").get() };
    for (const autoSync of [false, "false", 0, null]) {
      const response = await worker.fetch(saveRequest(settings({ repositories: [{ repository: "alice/project", autoSync }] })), env);
      assert.equal(response.status, 400);
      assert.deepEqual({ ...env.DB.native.prepare("SELECT * FROM app_settings").get() }, before);
    }
    const paused = await worker.fetch(saveRequest(settings({ syncEnabled: false, repositories: [{ repository: "alice/project", autoSync: false }] })), env);
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).nextSyncAt, null);
  });

  it("does not acquire a lease, advance the interval or record a run when every repository is manual-only", async (t) => {
    const env = await environment(t, { repositories: [{ repository: "alice/project", autoSync: false }] });
    const before = { ...env.DB.native.prepare("SELECT * FROM sync_state").get() };
    const fetch = stubGitHub(t, []);
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    assert.deepEqual({ ...env.DB.native.prepare("SELECT * FROM sync_state").get() }, before);
    const stored = await config(env);
    assert.equal(stored.nextSyncAt, null);
    assert.deepEqual(stored.recentRuns, []);
    assert.equal(fetch.mock.callCount(), 0);
  });
});

describe("custom synchronization intervals", () => {
  it("round-trips custom intervals and enforces them in Cron and the next-run estimate", async (t) => {
    t.mock.method(console, "log", () => {});
    const start = Date.UTC(2026, 8, 15, 12);
    let now = start + 1000;
    t.mock.method(Date, "now", () => now);
    const env = await environment(t);
    env.DB.native.prepare("UPDATE sessions SET expires_at = ?").run(start + 10_000_000);
    const saved = await worker.fetch(saveRequest(settings({ intervalMinutes: 90 })), env);
    assert.equal(saved.status, 200);
    const value = await saved.json();
    assert.equal(value.intervalMinutes, 90);
    assert.deepEqual(value.intervalRange, { min: 15, max: 10080, step: 15 });
    assert.ok(value.intervals.includes(10080));
    const fetch = stubGitHub(t, [repository(), merged(), repository(), merged()]);
    await worker.scheduled({ scheduledTime: start }, env);
    assert.equal((await config(env)).nextSyncAt, "2026-09-15T13:30:00.000Z");
    now = start + 75 * 60_000 + 1000;
    await worker.scheduled({ scheduledTime: start + 75 * 60_000 }, env);
    assert.equal(fetch.mock.callCount(), 2);
    now = start + 90 * 60_000 + 1000;
    await worker.scheduled({ scheduledTime: start + 90 * 60_000 }, env);
    assert.equal(fetch.mock.callCount(), 4);
    assert.equal((await config(env)).nextSyncAt, "2026-09-15T15:00:00.000Z");
    const weekly = await worker.fetch(saveRequest(settings({ revision: 2, intervalMinutes: 10080 })), env);
    assert.equal(weekly.status, 200);
    assert.equal((await weekly.json()).nextSyncAt, "2026-09-22T13:30:00.000Z");
  });

  it("rejects out-of-range, fractional and non-step intervals before any settings change", async (t) => {
    const env = await environment(t);
    const before = { ...env.DB.native.prepare("SELECT * FROM app_settings").get() };
    for (const intervalMinutes of [0, 14, 16, 30.5, 10095, "90", null]) {
      const response = await worker.fetch(saveRequest(settings({ intervalMinutes })), env);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /15–10080/);
      assert.deepEqual({ ...env.DB.native.prepare("SELECT * FROM app_settings").get() }, before);
    }
  });

  it("upgrades the old interval constraint while preserving all settings, sessions and sync state", (t) => {
    const db = new TestDatabase({ migrate: false });
    t.after(() => db.close());
    db.native.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    db.native.prepare(`INSERT INTO app_settings(id, password_hash, github_token, repositories, sync_enabled, interval_minutes, revision, auth_version, updated_at)
      VALUES (1, ?, ?, ?, 1, 180, 7, 3, ?)`).run("test-password-hash", "test-encrypted-token", '[{"repository":"alice/project"}]', "2026-09-15T12:00:00.000Z");
    db.native.prepare("INSERT INTO sessions(token_hash, auth_version, expires_at) VALUES (?, 3, ?)").run("test-session-hash", 123456789);
    db.native.prepare("UPDATE sync_state SET lock_id = ?, lock_until = ?, last_scheduled_at = ?").run("test-lease", 456000, 123000);
    const settingsBefore = { ...db.native.prepare("SELECT * FROM app_settings").get() };
    const sessionsBefore = db.native.prepare("SELECT * FROM sessions").all();
    const stateBefore = { ...db.native.prepare("SELECT * FROM sync_state").get() };
    assert.throws(() => db.native.prepare("UPDATE app_settings SET interval_minutes = 90").run(), /CHECK constraint/);
    db.applyMigrations();
    assert.deepEqual({ ...db.native.prepare("SELECT * FROM app_settings").get() }, settingsBefore);
    assert.deepEqual(db.native.prepare("SELECT * FROM sessions").all(), sessionsBefore);
    assert.deepEqual({ ...db.native.prepare("SELECT * FROM sync_state").get() }, stateBefore);
    for (const interval of [15, 45, 90, 2880, 10080]) db.native.prepare("UPDATE app_settings SET interval_minutes = ?").run(interval);
    for (const interval of [0, 16, 30.5, 10095]) {
      assert.throws(() => db.native.prepare("UPDATE app_settings SET interval_minutes = ?").run(interval), /CHECK constraint/);
    }
    db.applyMigrations();
    assert.equal(db.native.prepare("SELECT interval_minutes FROM app_settings").get().interval_minutes, 10080);
  });
});
