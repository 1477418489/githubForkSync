import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { decryptToken, sha256, verifyPassword } from "../src/crypto.ts";
import { COOKIE, ENCRYPTION_KEY, GITHUB_TOKEN, PASSWORD, SESSION_TOKEN, SETUP_TOKEN, environment, merged, repository, stubGitHub } from "./helpers.mjs";

function request(path, body, options = {}) {
  return new Request("https://fork-sync.example" + path, {
    method: body === undefined ? "GET" : "POST",
    ...options,
    headers: { Cookie: COOKIE, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function settings(overrides = {}) {
  return { revision: 1, repositories: [{ repository: "alice/project" }], syncEnabled: true, intervalMinutes: 60, ...overrides };
}
const silence = (t) => t.mock.method(console, "log", () => {});

describe("D1-backed HTTP API", () => {
  it("keeps health and static assets available without database configuration", async () => {
    const env = { ASSETS: { fetch: async () => new Response("asset") } };
    const response = await worker.fetch(request("/healthz"), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "github-fork-sync" });
    assert.equal(await (await worker.fetch(request("/"), env)).text(), "asset");
    assert.equal((await worker.fetch(request("/api/missing"), env)).status, 404);
  });

  it("fails closed when D1, its schema or the encryption key is missing", async (t) => {
    const env = await environment(t);
    for (const change of [{ DB: undefined }, { ENCRYPTION_KEY: undefined }, { ENCRYPTION_KEY: "weak" }]) {
      assert.equal((await worker.fetch(request("/api/status"), { ...env, ...change })).status, 503);
    }
    const empty = await environment(t, { migrate: false });
    assert.equal((await worker.fetch(request("/api/status"), empty)).status, 503);
  });

  it("only reveals initialization status before login", async (t) => {
    const fresh = await environment(t, { initialized: false });
    assert.deepEqual(await (await worker.fetch(request("/api/status"), fresh)).json(), { initialized: false });
    const existing = await environment(t, { overrides: { SETUP_TOKEN: undefined } });
    assert.deepEqual(await (await worker.fetch(request("/api/status"), existing)).json(), { initialized: true });
  });

  it("rejects query credentials, old bearer tokens and unknown sessions", async (t) => {
    const env = await environment(t);
    const fetch = stubGitHub(t, []);
    for (const headers of [{ Cookie: "" }, { Cookie: "", Authorization: "Bearer " + SESSION_TOKEN }, { Cookie: "fork_sync_session=" + "f".repeat(64) }]) {
      assert.equal((await worker.fetch(request("/api/config?token=" + SESSION_TOKEN, undefined, { headers }), env)).status, 401);
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("rejects cross-origin setup, login and authenticated writes", async (t) => {
    const env = await environment(t);
    for (const path of ["/api/setup", "/api/login", "/api/config", "/api/sync", "/api/logout"]) {
      const response = await worker.fetch(request(path, {}, { method: path === "/api/config" ? "PUT" : "POST", headers: { Origin: "https://evil.example" } }), env);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    }
  });

  it("requires the setup code, stores a password hash and issues a protected session", async (t) => {
    const env = await environment(t, { initialized: false });
    assert.equal((await worker.fetch(request("/api/setup", { setupToken: "wrong", password: PASSWORD }), env)).status, 401);
    assert.equal(env.DB.native.prepare("SELECT COUNT(*) AS n FROM app_settings").get().n, 0);
    const response = await worker.fetch(request("/api/setup", { setupToken: SETUP_TOKEN, password: PASSWORD }), env);
    assert.equal(response.status, 200);
    const cookie = response.headers.get("Set-Cookie");
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=28800"]) assert.ok(cookie.includes(attribute));
    const stored = env.DB.native.prepare("SELECT * FROM app_settings").get();
    assert.equal(stored.sync_enabled, 0);
    assert.equal(stored.github_token, null);
    assert.ok(!stored.password_hash.includes(PASSWORD));
    assert.equal(await verifyPassword(PASSWORD, stored.password_hash), true);
    const token = cookie.split(";")[0].split("=")[1];
    assert.equal(env.DB.native.prepare("SELECT token_hash FROM sessions").get().token_hash, await sha256(token));
    const state = await worker.fetch(request("/api/config", undefined, { headers: { Cookie: cookie.split(";")[0] } }), env);
    assert.equal(state.status, 200);
    assert.deepEqual((await state.json()).repositories, []);
  });

  it("permits exactly one administrator when initial setup requests race", async (t) => {
    const env = await environment(t, { initialized: false });
    const passwords = [PASSWORD, "another-strong-test-password"];
    const responses = await Promise.all(passwords.map((password) => worker.fetch(request("/api/setup", { setupToken: SETUP_TOKEN, password }), env)));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(env.DB.native.prepare("SELECT COUNT(*) AS n FROM app_settings").get().n, 1);
    const winner = responses.findIndex((r) => r.status === 200);
    assert.equal(await verifyPassword(passwords[winner], env.DB.native.prepare("SELECT password_hash FROM app_settings").get().password_hash), true);
    assert.equal((await worker.fetch(request("/api/setup", { setupToken: SETUP_TOKEN, password: PASSWORD }), env)).status, 409);
  });

  it("authenticates password logins and revokes sessions on logout", async (t) => {
    const env = await environment(t);
    assert.equal((await worker.fetch(request("/api/login", { password: "incorrect-password" }), env)).status, 401);
    const login = await worker.fetch(request("/api/login", { password: PASSWORD }), env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get("Set-Cookie").split(";")[0];
    assert.equal((await worker.fetch(request("/api/config", undefined, { headers: { Cookie: cookie } }), env)).status, 200);
    const logout = await worker.fetch(request("/api/logout", {}, { headers: { Cookie: cookie } }), env);
    assert.match(logout.headers.get("Set-Cookie"), /Max-Age=0/);
    assert.equal((await worker.fetch(request("/api/config", undefined, { headers: { Cookie: cookie } }), env)).status, 401);
  });

  it("rejects expired sessions and reads authorization from the primary database", async (t) => {
    const env = await environment(t);
    env.DB.native.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1);
    assert.equal((await worker.fetch(request("/api/config"), env)).status, 401);
    assert.ok(env.DB.sessionConstraints.length > 0);
    assert.ok(env.DB.sessionConstraints.every((constraint) => constraint === "first-primary"));
  });

  it("rate limits repeated login attempts per IP without storing the IP itself", async (t) => {
    const env = await environment(t);
    for (let i = 0; i < 10; i++) {
      assert.equal((await worker.fetch(request("/api/login", { password: "incorrect-password" }, { headers: { "CF-Connecting-IP": "192.0.2.42" } }), env)).status, 401);
    }
    const response = await worker.fetch(request("/api/login", { password: PASSWORD }, { headers: { "CF-Connecting-IP": "192.0.2.42" } }), env);
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("Retry-After")) > 0);
    assert.ok(!JSON.stringify(env.DB.native.prepare("SELECT * FROM auth_attempts").all()).includes("192.0.2.42"));
  });

  it("saves settings to SQLite, encrypts the token and never returns credentials", async (t) => {
    const env = await environment(t);
    const replacement = "new-github-test-token";
    const response = await worker.fetch(request("/api/config", settings({
      githubToken: replacement, repositories: [{ repository: "alice/another", branch: "feature/test" }], intervalMinutes: 30,
    }), { method: "PUT" }), env);
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const secret of [replacement, PASSWORD, ENCRYPTION_KEY, SETUP_TOKEN]) assert.ok(!body.includes(secret));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const row = env.DB.native.prepare("SELECT * FROM app_settings").get();
    assert.ok(!row.github_token.includes(replacement));
    assert.equal(await decryptToken(row.github_token, ENCRYPTION_KEY), replacement);
    assert.equal(row.interval_minutes, 30);
    assert.equal(row.revision, 2);
    assert.deepEqual(JSON.parse(row.repositories), [{ repository: "alice/another", branch: "feature/test" }]);
    const loaded = await (await worker.fetch(request("/api/config"), { ...env })).json();
    assert.equal(loaded.githubTokenConfigured, true);
    assert.equal(loaded.revision, 2);
  });

  it("preserves a token when left blank and supports explicitly clearing it", async (t) => {
    const env = await environment(t);
    const original = env.DB.native.prepare("SELECT github_token FROM app_settings").get().github_token;
    assert.equal((await worker.fetch(request("/api/config", settings({ githubToken: "" }), { method: "PUT" }), env)).status, 200);
    assert.equal(env.DB.native.prepare("SELECT github_token FROM app_settings").get().github_token, original);
    const cleared = await worker.fetch(request("/api/config", settings({ revision: 2, githubToken: null, syncEnabled: false, repositories: [] }), { method: "PUT" }), env);
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).githubTokenConfigured, false);
    assert.equal(env.DB.native.prepare("SELECT github_token FROM app_settings").get().github_token, null);
  });

  it("rejects invalid settings without partially updating the database", async (t) => {
    const env = await environment(t);
    for (const changes of [
      { syncEnabled: "false" }, { intervalMinutes: 10 }, { repositories: [] },
      { repositories: [{ repository: "alice/project" }, { repository: "ALICE/PROJECT" }] },
      { githubToken: null }, { githubToken: "bad\ntoken" }, { password: "short" }, { typo: true },
    ]) {
      const response = await worker.fetch(request("/api/config", settings(changes), { method: "PUT" }), env);
      assert.equal(response.status, 400, JSON.stringify(changes));
    }
    assert.equal(env.DB.native.prepare("SELECT revision FROM app_settings").get().revision, 1);
    assert.equal((await worker.fetch(request("/api/config", settings({ revision: 9 }), { method: "PUT" }), env)).status, 409);
  });

  it("detects concurrent configuration edits instead of silently overwriting them", async (t) => {
    const env = await environment(t);
    const responses = await Promise.all(["first-new-token", "second-new-token"].map((githubToken) =>
      worker.fetch(request("/api/config", settings({ githubToken }), { method: "PUT" }), env)));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(env.DB.native.prepare("SELECT revision FROM app_settings").get().revision, 2);
  });

  it("invalidates every old session when the admin password changes", async (t) => {
    const env = await environment(t);
    const response = await worker.fetch(request("/api/config", settings({ password: "new-strong-test-password" }), { method: "PUT" }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reloginRequired, true);
    assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
    assert.equal((await worker.fetch(request("/api/config"), env)).status, 401);
    assert.equal((await worker.fetch(request("/api/login", { password: PASSWORD }), env)).status, 401);
    assert.equal((await worker.fetch(request("/api/login", { password: "new-strong-test-password" }), env)).status, 200);
  });

  it("does not allow GET or malformed requests to trigger GitHub writes", async (t) => {
    const env = await environment(t);
    const fetch = stubGitHub(t, []);
    const method = await worker.fetch(request("/api/sync"), env);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("Allow"), "POST");
    for (const body of ["{", "null", "[]", '{"dryRun":"true"}', '{"dryrun":true}', '{"repository":"evil/repo"}']) {
      const response = await worker.fetch(new Request("https://fork-sync.example/api/sync", { method: "POST", headers: { Cookie: COOKIE, "Content-Type": "application/json" }, body }), env);
      assert.equal(response.status, 400, body);
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("enforces request types and byte limits before synchronization", async (t) => {
    const env = await environment(t);
    const fetch = stubGitHub(t, []);
    const response = await worker.fetch(new Request("https://fork-sync.example/api/sync", { method: "POST", headers: { Cookie: COOKIE }, body: "{}" }), env);
    assert.equal(response.status, 415);
    const oversized = await worker.fetch(new Request("https://fork-sync.example/api/sync", { method: "POST", headers: { Cookie: COOKIE, "Content-Type": "application/json" }, body: "中".repeat(400) }), env);
    assert.equal(oversized.status, 413);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("persists read-only check results without sending a GitHub write", async (t) => {
    silence(t);
    const env = await environment(t);
    const fetch = stubGitHub(t, [repository()]);
    const response = await worker.fetch(request("/api/sync", { dryRun: true }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).summary.checked, 1);
    assert.equal(fetch.mock.callCount(), 1);
    const stored = await (await worker.fetch(request("/api/config"), env)).json();
    assert.equal(stored.lastRun.dryRun, true);
    assert.equal(stored.running, false);
  });

  it("returns complete partial-failure results and stores them without secrets", async (t) => {
    const log = silence(t);
    const env = await environment(t, { repositories: [{ repository: "alice/project" }, { repository: "alice/another" }] });
    stubGitHub(t, [repository(), Response.json({ message: "Conflict" }, { status: 409 }), repository(), merged()]);
    const response = await worker.fetch(request("/api/sync", {}), env);
    assert.equal(response.status, 502);
    const report = await response.json();
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.synced, 1);
    const stored = env.DB.native.prepare("SELECT * FROM sync_state").get();
    assert.equal(stored.lock_until, 0);
    assert.equal(JSON.parse(stored.report_json).runId, report.runId);
    for (const secret of [GITHUB_TOKEN, ENCRYPTION_KEY, PASSWORD]) {
      assert.ok(!stored.report_json.includes(secret));
      assert.ok(!JSON.stringify(log.mock.calls).includes(secret));
    }
  });

  it("runs manually while the automatic schedule is paused", async (t) => {
    silence(t);
    const env = await environment(t, { syncEnabled: false });
    const fetch = stubGitHub(t, [repository(), merged()]);
    await worker.scheduled({}, env);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal((await worker.fetch(request("/api/sync", {}), env)).status, 200);
    assert.equal(fetch.mock.callCount(), 2);
  });

  it("skips Cron before setup and respects the stored interval after setup", async (t) => {
    silence(t);
    const fresh = await environment(t, { initialized: false });
    const env = await environment(t, { intervalMinutes: 180 });
    const fetch = stubGitHub(t, [repository(), merged()]);
    await worker.scheduled({}, fresh);
    assert.equal(fetch.mock.callCount(), 0);
    await worker.scheduled({}, env);
    assert.equal(fetch.mock.callCount(), 2);
    await worker.scheduled({}, env);
    assert.equal(fetch.mock.callCount(), 2);
    const report = JSON.parse(env.DB.native.prepare("SELECT report_json FROM sync_state").get().report_json);
    assert.equal(report.trigger, "scheduled");
  });

  it("uses Cron timestamps so dispatch jitter does not skip the next interval", async (t) => {
    silence(t);
    const env = await environment(t);
    const scheduledAt = Date.UTC(2026, 8, 15, 12);
    let now = scheduledAt + 5000;
    t.mock.method(Date, "now", () => now);
    const fetch = stubGitHub(t, [repository(), merged(), repository(), merged()]);
    await worker.scheduled({ scheduledTime: scheduledAt }, env);
    assert.equal(fetch.mock.callCount(), 2);
    // 第二次调用只延迟一秒，按实际到达时间计算会错误地再等 15 分钟。
    now = scheduledAt + 3_600_000 + 1000;
    await worker.scheduled({ scheduledTime: scheduledAt + 3_600_000 }, env);
    assert.equal(fetch.mock.callCount(), 4);
    assert.equal(env.DB.native.prepare("SELECT last_scheduled_at FROM sync_state").get().last_scheduled_at, scheduledAt + 3_600_000);
  });

  it("records failed Cron runs, releases their locks and delays the next attempt", async (t) => {
    silence(t);
    const env = await environment(t);
    const fetch = stubGitHub(t, [repository(), Response.json({ message: "Conflict" }, { status: 409 })]);
    await assert.rejects(worker.scheduled({}, env), /同步失败/);
    const row = env.DB.native.prepare("SELECT * FROM sync_state").get();
    assert.equal(row.lock_until, 0);
    assert.ok(row.last_scheduled_at > 0);
    assert.equal(JSON.parse(row.report_json).summary.failed, 1);
    await worker.scheduled({}, env);
    assert.equal(fetch.mock.callCount(), 2);
  });

  it("excludes concurrent runs across Worker instances and releases the lease afterwards", async (t) => {
    silence(t);
    const env = await environment(t);
    let started;
    let release;
    const pending = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
      if (init.method === "GET") { started(); await gate; return Response.json(repository()); }
      return Response.json(merged());
    });
    const first = worker.fetch(request("/api/sync", {}), env);
    await pending;
    const second = await worker.fetch(request("/api/sync", {}), { ...env });
    release();
    assert.equal(second.status, 409);
    assert.equal((await first).status, 200);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(env.DB.native.prepare("SELECT lock_until FROM sync_state").get().lock_until, 0);
  });

  it("recovers expired locks without retaining an abandoned owner", async (t) => {
    silence(t);
    const env = await environment(t);
    env.DB.native.prepare("UPDATE sync_state SET lock_id = 'abandoned', lock_until = ?").run(Date.now() - 1);
    stubGitHub(t, [repository(), merged()]);
    assert.equal((await worker.fetch(request("/api/sync", {}), env)).status, 200);
    assert.equal(env.DB.native.prepare("SELECT lock_id FROM sync_state").get().lock_id, null);
  });

  it("reapplying the initial schema preserves settings and the administrator", async (t) => {
    const env = await environment(t);
    const before = { ...env.DB.native.prepare("SELECT * FROM app_settings").get() };
    env.DB.applyMigrations();
    assert.deepEqual({ ...env.DB.native.prepare("SELECT * FROM app_settings").get() }, before);
    assert.equal(env.DB.native.prepare("SELECT COUNT(*) AS n FROM sync_state").get().n, 1);
  });
});
