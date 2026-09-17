import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { authorizedRequest, branchRef, environment, jsonRequest, merged, repository, stubGitHub } from "./helpers.mjs";

const saveRequest = (body) => authorizedRequest("/api/config", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const settings = (repositories, overrides = {}) => ({ revision: 1, repositories, syncEnabled: true, intervalMinutes: 60, ...overrides });
const silence = (t) => t.mock.method(console, "log", () => {});

describe("manual repository selection and strategy overrides", () => {
  it("syncs only selected saved repositories and uses their saved branches", async (t) => {
    silence(t);
    const repositories = [{ repository: "alice/project", syncMode: "force" }, { repository: "alice/another", branch: "release" }];
    const env = await environment(t, { repositories });
    const fetch = stubGitHub(t, [repository(), merged()]);
    const response = await worker.fetch(jsonRequest({ repositories: ["ALICE/ANOTHER"] }), env);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.summary.total, 1);
    assert.equal(report.results[0].repository, "alice/another");
    assert.equal(report.results[0].branch, "release");
    assert.ok(fetch.mock.calls.every(({ arguments: [url] }) => url.includes("/alice/another")));
    assert.deepEqual(JSON.parse(fetch.mock.calls[1].arguments[1].body), { branch: "release" });
    assert.deepEqual(JSON.parse(env.DB.native.prepare("SELECT repositories FROM app_settings").get().repositories), repositories);
    const history = JSON.parse(env.DB.native.prepare("SELECT report_json FROM sync_history").get().report_json);
    assert.deepEqual(history, report);
  });

  it("can temporarily merge a repository configured for force without changing its saved strategy", async (t) => {
    silence(t);
    const repositories = [{ repository: "alice/project", syncMode: "force" }];
    const env = await environment(t, { repositories });
    const fetch = stubGitHub(t, [repository(), merged()]);
    const response = await worker.fetch(jsonRequest({ syncMode: "merge" }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].syncMode, "merge");
    assert.equal(fetch.mock.callCount(), 2);
    assert.deepEqual(JSON.parse(env.DB.native.prepare("SELECT repositories FROM app_settings").get().repositories), repositories);
  });

  it("forces only the selection and persists the verified result without persisting the override", async (t) => {
    silence(t);
    const repositories = [{ repository: "alice/project" }, { repository: "alice/another" }];
    const env = await environment(t, { repositories });
    const fetch = stubGitHub(t, [repository(), branchRef(), branchRef("a".repeat(40)), branchRef(), branchRef()]);
    const response = await worker.fetch(jsonRequest({ repositories: ["alice/project"], syncMode: "force", revision: 1 }), env);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.summary.total, 1);
    assert.equal(report.results[0].syncMode, "force");
    assert.equal(report.results[0].syncedSha, "b".repeat(40));
    assert.ok(fetch.mock.calls.every(({ arguments: [url] }) => !url.includes("/alice/another")));
    const state = await (await worker.fetch(authorizedRequest("/api/config"), env)).json();
    assert.deepEqual(state.repositories, repositories);
    assert.equal(state.revision, 1);
    assert.deepEqual(state.recentRuns[0], report);
    assert.equal(state.running, false);
  });

  it("rejects empty, unknown and malformed selections before acquiring a lock or calling GitHub", async (t) => {
    const env = await environment(t);
    const fetch = stubGitHub(t, []);
    for (const body of [
      { repositories: [] }, { repositories: ["alice/project", "alice/unknown"] },
      { repositories: ["alice/project", "ALICE/PROJECT"] }, { repositories: "alice/project" },
      { repositories: [{ repository: "alice/project", branch: "other" }] },
      { syncMode: "reset" }, { revision: "1" },
    ]) {
      assert.equal((await worker.fetch(jsonRequest(body), env)).status, 400, JSON.stringify(body));
    }
    assert.equal(fetch.mock.callCount(), 0);
    const state = env.DB.native.prepare("SELECT * FROM sync_state").get();
    assert.equal(state.lock_id, null);
    assert.equal(state.report_json, null);
    assert.equal(env.DB.native.prepare("SELECT COUNT(*) AS n FROM sync_history").get().n, 0);
  });

  it("requires a current revision for destructive runs, including a saved force strategy", async (t) => {
    const env = await environment(t, { repositories: [{ repository: "alice/project", syncMode: "force" }] });
    const fetch = stubGitHub(t, []);
    assert.equal((await worker.fetch(jsonRequest({}), env)).status, 400);
    assert.equal((await worker.fetch(jsonRequest({ syncMode: "force" }), env)).status, 400);
    assert.equal((await worker.fetch(jsonRequest({ syncMode: "force", revision: 2 }), env)).status, 409);
    assert.equal((await worker.fetch(jsonRequest({ syncMode: "merge", revision: 2 }), env)).status, 409);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(env.DB.native.prepare("SELECT lock_until FROM sync_state").get().lock_until, 0);
  });

  it("allows a read-only force check without write confirmation and accepts 20 long repository names", async (t) => {
    silence(t);
    const repositories = Array.from({ length: 20 }, (_, index) => ({ repository: "a".repeat(39) + "/" + String(index).padStart(100, "r") }));
    const env = await environment(t, { repositories });
    const fetch = stubGitHub(t, repositories.map(() => repository()));
    const response = await worker.fetch(jsonRequest({ dryRun: true, repositories: repositories.map((target) => target.repository), syncMode: "force" }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).summary.checked, 20);
    assert.equal(fetch.mock.callCount(), 20);
    assert.ok(fetch.mock.calls.every(({ arguments: [, init] }) => init.method === "GET"));
  });

  it("rejects an oversized force override before writes, and permits a smaller selection", async (t) => {
    silence(t);
    const repositories = Array.from({ length: 20 }, (_, index) => ({ repository: "alice/repo" + index }));
    const env = await environment(t, { repositories });
    const fetch = stubGitHub(t, [repository(), branchRef(), branchRef()]);
    const oversized = await worker.fetch(jsonRequest({ syncMode: "force", revision: 1 }), env);
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /超过单轮/);
    assert.equal(fetch.mock.callCount(), 0);
    const selected = await worker.fetch(jsonRequest({ syncMode: "force", revision: 1, repositories: ["alice/repo0"] }), env);
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).summary.up_to_date, 1);
  });
});

describe("saved synchronization strategies", () => {
  it("round-trips strategies in the existing JSON column and uses them for Cron", async (t) => {
    silence(t);
    const env = await environment(t);
    const repositories = [{ repository: "alice/project", syncMode: "force" }, { repository: "alice/another", syncMode: "merge" }];
    const saved = await worker.fetch(saveRequest(settings(repositories)), env);
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).repositories, repositories);
    assert.deepEqual((await (await worker.fetch(authorizedRequest("/api/config"), env)).json()).repositories, repositories);
    const fetch = stubGitHub(t, [repository(), branchRef(), branchRef("a".repeat(40)), branchRef(), branchRef(), repository(), merged()]);
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    const report = JSON.parse(env.DB.native.prepare("SELECT report_json FROM sync_state").get().report_json);
    assert.equal(report.trigger, "scheduled");
    assert.deepEqual(report.results.map((result) => result.syncMode), ["force", "merge"]);
    assert.equal(report.summary.synced, 2);
    assert.equal(fetch.mock.callCount(), 7);
  });

  it("rejects an invalid strategy without changing any settings", async (t) => {
    const env = await environment(t);
    const before = { ...env.DB.native.prepare("SELECT * FROM app_settings").get() };
    const response = await worker.fetch(saveRequest(settings([{ repository: "alice/project", syncMode: "reset" }])), env);
    assert.equal(response.status, 400);
    assert.deepEqual({ ...env.DB.native.prepare("SELECT * FROM app_settings").get() }, before);
  });

  it("allows a large force configuration while paused but rejects enabling an oversized automatic run", async (t) => {
    const env = await environment(t);
    const repositories = Array.from({ length: 11 }, (_, index) => ({ repository: "alice/repo" + index, syncMode: "force" }));
    assert.equal((await worker.fetch(saveRequest(settings(repositories)), env)).status, 400);
    assert.equal(env.DB.native.prepare("SELECT revision FROM app_settings").get().revision, 1);
    assert.equal((await worker.fetch(saveRequest(settings(repositories, { syncEnabled: false })), env)).status, 200);
    assert.equal((await worker.fetch(saveRequest(settings(repositories, { revision: 2 })), env)).status, 400);
    const row = env.DB.native.prepare("SELECT * FROM app_settings").get();
    assert.equal(row.sync_enabled, 0);
    assert.equal(row.revision, 2);
  });
});
