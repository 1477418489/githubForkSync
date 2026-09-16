import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { TestDatabase } from "./database.mjs";
import { authorizedRequest, ENCRYPTION_KEY, GITHUB_TOKEN, PASSWORD, environment, jsonRequest, merged, repository, stubGitHub } from "./helpers.mjs";

async function config(env) {
  const response = await worker.fetch(authorizedRequest("/api/config"), env);
  assert.equal(response.status, 200);
  return response.json();
}

function report(runId) {
  return {
    runId, trigger: "manual", dryRun: false, ok: true,
    startedAt: "2026-09-15T12:00:00.000Z", finishedAt: "2026-09-15T12:00:00.000Z",
    summary: { total: 1, synced: 1, up_to_date: 0, checked: 0, failed: 0, skipped: 0 },
    results: [{ repository: "alice/project", branch: "main", upstream: "upstream/project", status: "synced", message: "Synced" }],
  };
}

describe("persisted run history", () => {
  it("keeps only the latest 20 completed runs in reverse completion order", async (t) => {
    t.mock.method(console, "log", () => {});
    const env = await environment(t);
    stubGitHub(t, Array.from({ length: 23 }, () => [repository(), merged()]).flat());
    const reports = [];
    for (let index = 0; index < 23; index++) {
      const response = await worker.fetch(jsonRequest({}), env);
      assert.equal(response.status, 200);
      reports.push(await response.json());
    }
    const stored = await config({ ...env });
    assert.equal(stored.historyLimit, 20);
    assert.deepEqual(stored.recentRuns, reports.slice(-20).reverse());
    assert.deepEqual(stored.lastRun, reports.at(-1));
    assert.equal(env.DB.native.prepare("SELECT COUNT(*) AS n FROM sync_history").get().n, 20);
    const anonymous = await worker.fetch(authorizedRequest("/api/config", { headers: { Cookie: "" } }), env);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await (await worker.fetch(authorizedRequest("/api/status"), env)).json(), { initialized: true });
    for (const secret of [GITHUB_TOKEN, ENCRYPTION_KEY, PASSWORD]) assert.ok(!JSON.stringify(stored).includes(secret));
  });

  it("records checks, automatic runs and failures without recording skipped Cron ticks", async (t) => {
    t.mock.method(console, "log", () => {});
    const env = await environment(t);
    const fetch = stubGitHub(t, [repository(), repository(), merged(), repository(), Response.json({ message: "Conflict " + GITHUB_TOKEN }, { status: 409 })]);
    assert.equal((await worker.fetch(jsonRequest({ dryRun: true }), env)).status, 200);
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    assert.equal((await worker.fetch(jsonRequest({}), env)).status, 502);
    const stored = await config(env);
    assert.equal(stored.recentRuns.length, 3);
    assert.equal(stored.recentRuns[0].ok, false);
    assert.equal(stored.recentRuns[0].results[0].code, "conflict");
    assert.equal(stored.recentRuns[1].trigger, "scheduled");
    assert.equal(stored.recentRuns[2].dryRun, true);
    assert.equal(fetch.mock.callCount(), 5);
    const saved = env.DB.native.prepare("SELECT report_json FROM sync_history").all();
    assert.ok(!JSON.stringify(saved).includes(GITHUB_TOKEN));
  });

  it("migrates the previous last report once while preserving settings", (t) => {
    const db = new TestDatabase({ migrate: false });
    t.after(() => db.close());
    db.native.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    db.native.prepare("INSERT INTO app_settings(id, password_hash, updated_at) VALUES (1, ?, ?)")
      .run("existing-password-hash", "2026-09-15T12:00:00.000Z");
    const previous = report("legacy-report");
    db.native.prepare("UPDATE sync_state SET report_json = ?").run(JSON.stringify(previous));
    const settings = { ...db.native.prepare("SELECT * FROM app_settings").get() };
    db.applyMigrations();
    db.applyMigrations();
    const rows = db.native.prepare("SELECT report_json FROM sync_history").all();
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].report_json), previous);
    assert.deepEqual({ ...db.native.prepare("SELECT * FROM app_settings").get() }, settings);
    assert.deepEqual(JSON.parse(db.native.prepare("SELECT report_json FROM sync_state").get().report_json), previous);
  });

  it("rolls back history insertion and pruning if the latest-report update fails", async (t) => {
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "error", () => {});
    const env = await environment(t);
    for (let index = 0; index < 20; index++) {
      env.DB.native.prepare("INSERT INTO sync_history(run_id, report_json) VALUES (?, ?)")
        .run("prior-" + index, JSON.stringify(report("prior-" + index)));
    }
    const previous = JSON.stringify(report("prior-19"));
    env.DB.native.prepare("UPDATE sync_state SET report_json = ?").run(previous);
    env.DB.native.exec(`CREATE TRIGGER fail_report BEFORE UPDATE OF report_json ON sync_state
      BEGIN SELECT RAISE(ABORT, 'Simulated write failure'); END;`);
    stubGitHub(t, [repository(), merged()]);
    assert.equal((await worker.fetch(jsonRequest({}), env)).status, 500);
    assert.deepEqual(env.DB.native.prepare("SELECT run_id FROM sync_history ORDER BY id").all().map((row) => row.run_id),
      Array.from({ length: 20 }, (_, index) => "prior-" + index));
    const state = env.DB.native.prepare("SELECT * FROM sync_state").get();
    assert.equal(state.report_json, previous);
    assert.equal(state.lock_until, 0);
  });

  it("does not store a stale run after another execution acquires its lease", async (t) => {
    t.mock.method(console, "log", () => {});
    const env = await environment(t);
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      if (init.method === "GET") {
        env.DB.native.prepare("UPDATE sync_state SET lock_id = ?, lock_until = ?").run("new-owner", Date.now() + 60_000);
        return Response.json(repository());
      }
      return Response.json(merged());
    });
    assert.equal((await worker.fetch(jsonRequest({}), env)).status, 200);
    assert.equal(env.DB.native.prepare("SELECT COUNT(*) AS n FROM sync_history").get().n, 0);
    const state = env.DB.native.prepare("SELECT * FROM sync_state").get();
    assert.equal(state.lock_id, "new-owner");
    assert.equal(state.report_json, null);
  });
});

describe("estimated next automatic sync", () => {
  it("aligns to Cron ticks and respects every supported interval", async (t) => {
    let now = Date.UTC(2026, 8, 15, 12, 7);
    t.mock.method(Date, "now", () => now);
    const env = await environment(t);
    env.DB.native.prepare("UPDATE sessions SET expires_at = ?").run(now + 2 * 3_600_000);
    assert.equal((await config(env)).nextSyncAt, "2026-09-15T12:15:00.000Z");
    const lastScheduled = Date.UTC(2026, 8, 15, 12);
    env.DB.native.prepare("UPDATE sync_state SET last_scheduled_at = ?").run(lastScheduled);
    for (const interval of [15, 30, 60, 180, 360, 720, 1440]) {
      env.DB.native.prepare("UPDATE app_settings SET interval_minutes = ?").run(interval);
      assert.equal((await config(env)).nextSyncAt, new Date(lastScheduled + interval * 60_000).toISOString());
    }
    env.DB.native.prepare("UPDATE app_settings SET interval_minutes = 15").run();
    now = Date.UTC(2026, 8, 15, 13, 7);
    assert.equal((await config(env)).nextSyncAt, "2026-09-15T13:15:00.000Z");
    now = Date.UTC(2026, 8, 15, 13, 15);
    assert.equal((await config(env)).nextSyncAt, "2026-09-15T13:30:00.000Z");
  });

  it("recomputes after settings changes and returns null while paused or unconfigured", async (t) => {
    t.mock.method(Date, "now", () => Date.UTC(2026, 8, 15, 12, 7));
    const env = await environment(t);
    env.DB.native.prepare("UPDATE sync_state SET last_scheduled_at = ?").run(Date.UTC(2026, 8, 15, 12));
    assert.equal((await config(env)).nextSyncAt, "2026-09-15T13:00:00.000Z");
    for (const [syncEnabled, intervalMinutes, expected] of [
      [true, 180, "2026-09-15T15:00:00.000Z"], [false, 180, null], [true, 30, "2026-09-15T12:30:00.000Z"],
    ]) {
      const current = await config(env);
      const response = await worker.fetch(authorizedRequest("/api/config", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositories: current.repositories, revision: current.revision, syncEnabled, intervalMinutes }),
      }), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).nextSyncAt, expected);
    }
    env.DB.native.prepare("UPDATE app_settings SET github_token = NULL").run();
    assert.equal((await config(env)).nextSyncAt, null);
    const empty = await environment(t, { configured: false });
    assert.equal((await config(empty)).nextSyncAt, null);
    assert.deepEqual((await config(empty)).recentRuns, []);
  });

  it("keeps manual runs independent and advances the schedule after failed automatic runs", async (t) => {
    t.mock.method(console, "log", () => {});
    let now = Date.UTC(2026, 8, 15, 12, 7);
    t.mock.method(Date, "now", () => now);
    const env = await environment(t);
    env.DB.native.prepare("UPDATE sync_state SET last_scheduled_at = ?").run(Date.UTC(2026, 8, 15, 12));
    stubGitHub(t, [repository(), merged(), repository(), Response.json({ message: "Conflict" }, { status: 409 })]);
    assert.equal((await worker.fetch(jsonRequest({}), env)).status, 200);
    assert.equal((await config(env)).nextSyncAt, "2026-09-15T13:00:00.000Z");
    now = Date.UTC(2026, 8, 15, 13, 0, 5);
    await assert.rejects(worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 15, 13) }, env), /同步失败/);
    const stored = await config(env);
    assert.equal(stored.nextSyncAt, "2026-09-15T14:00:00.000Z");
    assert.equal(stored.recentRuns[0].ok, false);
    assert.equal(stored.recentRuns[0].trigger, "scheduled");
    assert.equal(stored.running, false);
  });
});
