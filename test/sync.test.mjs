import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSync } from "../src/sync.ts";
import { GITHUB_TIMEOUT_MS } from "../src/github.ts";
import { configuration, GITHUB_TOKEN, merged, repository, stubGitHub } from "./helpers.mjs";

const twoRepos = [{ repository: "alice/project" }, { repository: "alice/another" }];

describe("GitHub fork synchronization", () => {
  it("resolves the default branch and sends only a merge-upstream request", async (t) => {
    const fetch = stubGitHub(t, [repository({ default_branch: "develop" }), merged()]);
    const report = await runSync(configuration(), "manual");
    assert.equal(report.ok, true);
    assert.equal(report.summary.synced, 1);
    assert.equal(report.results[0].branch, "develop");
    assert.equal(report.results[0].upstream, "upstream/project");
    assert.equal(fetch.mock.callCount(), 2);
    const [url, init] = fetch.mock.calls[1].arguments;
    assert.equal(url, "https://api.github.com/repos/alice/project/merge-upstream");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.deepEqual(JSON.parse(init.body), { branch: "develop" });
    assert.equal(init.headers.Authorization, `Bearer ${GITHUB_TOKEN}`);
    assert.equal(init.headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.ok(init.headers["User-Agent"]);
  });

  it("uses the configured branch without putting branch text in the request path", async (t) => {
    const fetch = stubGitHub(t, [repository(), merged("merge")]);
    const env = configuration({ repositories: [{ repository: "alice/project", branch: "feature/中文" }] });
    const report = await runSync(env, "manual");
    assert.equal(report.results[0].status, "synced");
    assert.equal(report.results[0].mergeType, "merge");
    assert.deepEqual(JSON.parse(fetch.mock.calls[1].arguments[1].body), { branch: "feature/中文" });
  });

  it("distinguishes an already up-to-date fork", async (t) => {
    stubGitHub(t, [repository(), merged("none")]);
    const report = await runSync(configuration(), "scheduled");
    assert.equal(report.results[0].status, "up_to_date");
    assert.equal(report.summary.synced, 0);
    assert.equal(report.summary.up_to_date, 1);
  });

  it("dry-run reads metadata and never writes", async (t) => {
    const fetch = stubGitHub(t, [repository()]);
    const report = await runSync(configuration(), "manual", true);
    assert.equal(report.dryRun, true);
    assert.equal(report.results[0].status, "checked");
    assert.match(report.results[0].message, /未验证/);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[1].method, "GET");
  });

  for (const [label, change, code] of [
    ["non-forks", { fork: false, parent: undefined }, "not_a_fork"],
    ["archived repositories", { archived: true }, "repository_readonly"],
    ["disabled repositories", { disabled: true }, "repository_readonly"],
  ]) {
    it(`refuses to write to ${label}`, async (t) => {
      const fetch = stubGitHub(t, [repository(change)]);
      const report = await runSync(configuration(), "manual");
      assert.equal(report.ok, false);
      assert.equal(report.results[0].code, code);
      assert.equal(fetch.mock.callCount(), 1);
    });
  }

  for (const [status, code] of [[409, "conflict"], [422, "validation_failed"], [403, "permission_denied"], [404, "not_found"]]) {
    it(`reports HTTP ${status} and continues with the next repository`, async (t) => {
      const fetch = stubGitHub(t, [
        repository(), Response.json({ message: "Cannot sync this branch" }, { status }),
        repository(), merged(),
      ]);
      const report = await runSync(configuration({ repositories: twoRepos }), "manual");
      assert.equal(report.ok, false);
      assert.equal(report.results[0].code, code);
      assert.equal(report.results[0].githubStatus, status);
      assert.equal(report.results[1].status, "synced");
      assert.equal(report.summary.failed, 1);
      assert.equal(report.summary.synced, 1);
      assert.equal(fetch.mock.callCount(), 4);
    });
  }

  for (const [label, status, headers, message] of [
    ["429", 429, { "retry-after": "60" }, "Too many requests"],
    ["primary limit", 403, { "x-ratelimit-remaining": "0" }, "Forbidden"],
    ["secondary limit", 403, {}, "You have exceeded a secondary rate limit"],
    ["retry-after", 403, { "retry-after": "30" }, "Forbidden"],
    ["bad credentials", 401, {}, "Bad credentials"],
  ]) {
    it(`halts remaining repositories after ${label}`, async (t) => {
      const fetch = stubGitHub(t, [Response.json({ message }, { status, headers })]);
      const report = await runSync(configuration({ repositories: twoRepos }), "scheduled");
      assert.equal(report.results[0].code, status === 401 ? "authentication_failed" : "rate_limited");
      assert.equal(report.results[1].status, "skipped");
      assert.equal(report.summary.failed, 1);
      assert.equal(report.summary.skipped, 1);
      assert.equal(report.ok, false);
      assert.equal(fetch.mock.callCount(), 1);
      if (headers["retry-after"]) assert.equal(report.results[0].retryAfter, headers["retry-after"]);
    });
  }

  it("validates the entire configuration before making any GitHub requests", async (t) => {
    const fetch = stubGitHub(t, []);
    await assert.rejects(runSync(configuration({ repositories: [...twoRepos, { repository: "invalid" }] }), "manual"));
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("rejects unexpected metadata instead of writing based on it", async (t) => {
    const fetch = stubGitHub(t, [{ fork: true, default_branch: "main" }]);
    const report = await runSync(configuration(), "manual");
    assert.equal(report.results[0].code, "invalid_response");
    assert.equal(fetch.mock.callCount(), 1);
  });

  it("does not claim success for malformed merge responses", async (t) => {
    stubGitHub(t, [repository(), { message: "ok", merge_type: "unexpected" }]);
    const report = await runSync(configuration(), "manual");
    assert.equal(report.ok, false);
    assert.equal(report.results[0].code, "invalid_response");
  });

  it("does not follow redirects with GitHub credentials", async (t) => {
    const fetch = stubGitHub(t, [new Response(null, { status: 301, headers: { Location: "https://elsewhere.example" } })]);
    const report = await runSync(configuration(), "manual");
    assert.equal(report.results[0].code, "repository_moved");
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[1].redirect, "manual");
  });

  it("redacts credentials from upstream error messages", async (t) => {
    stubGitHub(t, [Response.json({ message: `Invalid token ${GITHUB_TOKEN}` }, { status: 401 })]);
    const report = await runSync(configuration(), "manual");
    assert.ok(!JSON.stringify(report).includes(GITHUB_TOKEN));
    assert.match(report.results[0].message, /\[redacted\]/);
  });

  it("handles non-JSON GitHub failures without exposing raw response contents", async (t) => {
    stubGitHub(t, [new Response("<html>private internal diagnostic</html>", { status: 503 })]);
    const report = await runSync(configuration(), "manual");
    assert.equal(report.results[0].githubStatus, 503);
    assert.ok(!JSON.stringify(report).includes("private internal"));
  });

  it("does not retry ambiguous network failures or leak their raw errors", async (t) => {
    const fetch = stubGitHub(t, [repository(), new Error(`network diagnostic ${GITHUB_TOKEN}`)]);
    const report = await runSync(configuration(), "manual");
    assert.equal(report.results[0].code, "network_error");
    assert.match(report.results[0].message, /更新可能已生效/);
    assert.ok(!JSON.stringify(report).includes(GITHUB_TOKEN));
    assert.equal(fetch.mock.callCount(), 2);
  });

  it("aborts a stalled GitHub request after the timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(globalThis, "fetch", (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = runSync(configuration(), "manual");
    t.mock.timers.tick(GITHUB_TIMEOUT_MS);
    const report = await pending;
    assert.equal(report.results[0].code, "timeout");
    assert.equal(report.ok, false);
  });
});
