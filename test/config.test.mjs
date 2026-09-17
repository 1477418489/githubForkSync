import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError, validatePassword, validateGitHubToken, parseRepositories, parseSyncOptions, validateSyncBudget } from "../src/config.ts";
import { GITHUB_TOKEN, PASSWORD } from "./helpers.mjs";

describe("repository configuration", () => {
  it("accepts repository arrays from the API and JSON text from D1", () => {
    const targets = [{ repository: "alice/project" }, { repository: "alice/another", branch: "feature/中文" }];
    assert.deepEqual(parseRepositories(targets), targets);
    assert.deepEqual(parseRepositories(JSON.stringify(targets)), targets);
    assert.deepEqual(parseRepositories([{ repository: " alice/project " }]), [{ repository: "alice/project" }]);
  });

  it("fails fast on empty, oversized, malformed or non-array configuration", () => {
    for (const value of [undefined, null, "{", "{}", [], "[]", Array.from({ length: 21 }, (_, i) => ({ repository: `alice/repo${i}` }))]) {
      assert.throws(() => parseRepositories(value), ConfigurationError);
    }
  });

  it("rejects URLs, traversal paths and unexpected fields", () => {
    for (const repository of ["https://github.com/alice/repo", "alice/..", "alice/.", "../repo", "alice/repo/extra", "alice/repo?x=1"]) {
      assert.throws(() => parseRepositories([{ repository }]), ConfigurationError);
    }
    assert.throws(() => parseRepositories([{ repository: "alice/project", branches: ["main"] }]), /只支持/);
    for (const entry of [null, "alice/project", [], {}, { repository: 123 }]) {
      assert.throws(() => parseRepositories([entry]), ConfigurationError);
    }
  });

  it("rejects duplicates regardless of case or branch selection", () => {
    assert.throws(() => parseRepositories([
      { repository: "alice/project" },
      { repository: "ALICE/Project", branch: "main" },
    ]), /重复/);
  });

  it("rejects empty or malformed branch fields instead of falling back to default", () => {
    for (const branch of ["", " ", "main\n", "a".repeat(256), null, 123]) {
      assert.throws(() => parseRepositories([{ repository: "alice/project", branch }]), /branch/);
    }
  });

  it("permits an empty repository list only when explicitly allowed", () => {
    assert.deepEqual(parseRepositories([], true), []);
    assert.throws(() => parseRepositories([]), ConfigurationError);
  });

  it("preserves explicit strategies and keeps older configurations valid", () => {
    const targets = [{ repository: "alice/project", syncMode: "merge" }, { repository: "alice/another", syncMode: "force" }];
    assert.deepEqual(parseRepositories(JSON.stringify(targets)), targets);
    assert.deepEqual(parseRepositories([{ repository: "alice/project" }]), [{ repository: "alice/project" }]);
    for (const syncMode of [null, true, "reset", "FORCE", ""]) {
      assert.throws(() => parseRepositories([{ repository: "alice/project", syncMode }]), /syncMode/);
    }
  });

  it("rejects branch names that could address another ref or normalize a request path", () => {
    for (const branch of ["../main", "feature/../main", "/main", "main/", "main//test", ".hidden", "main.lock", "main.", "a..b", "main@{1}", "a:b", "a?b", "a*b", "a[b", "a\\b", "-main"]) {
      assert.throws(() => parseRepositories([{ repository: "alice/project", branch, syncMode: "force" }]), /branch/, branch);
    }
    assert.equal(parseRepositories([{ repository: "alice/project", branch: "feature/中文#1" }])[0].branch, "feature/中文#1");
  });

  it("accepts optional selections and rejects malformed sync options before running", () => {
    assert.deepEqual(parseSyncOptions({}), {});
    assert.deepEqual(parseSyncOptions({ dryRun: true, repositories: [" alice/project "], syncMode: "force", revision: 2 }),
      { dryRun: true, repositories: ["alice/project"], syncMode: "force", revision: 2 });
    for (const options of [
      { repositories: [] }, { repositories: "alice/project" }, { repositories: [null] },
      { repositories: [{ repository: "alice/project" }] }, { repositories: ["alice/project", "ALICE/PROJECT"] },
      { syncMode: null }, { syncMode: "reset" }, { force: true }, { dryRun: "true" },
      { revision: "1" }, { revision: 0 }, { revision: 1.5 },
    ]) assert.throws(() => parseSyncOptions(options), ConfigurationError, JSON.stringify(options));
  });

  it("accounts for force verification requests without reducing the old 20-fork merge limit", () => {
    const targets = Array.from({ length: 20 }, (_, index) => ({ repository: "alice/repo" + index }));
    assert.doesNotThrow(() => validateSyncBudget(targets));
    const forceTargets = targets.map((target) => ({ ...target, syncMode: "force" }));
    assert.doesNotThrow(() => validateSyncBudget(forceTargets.slice(0, 10)));
    assert.throws(() => validateSyncBudget(forceTargets.slice(0, 11)), /55.*50/);
    assert.doesNotThrow(() => validateSyncBudget([...forceTargets.slice(0, 6), ...targets.slice(6, 16)]));
    assert.throws(() => validateSyncBudget([...forceTargets.slice(0, 6), ...targets.slice(6, 17)]), /52.*50/);
  });

  it("validates GitHub tokens and admin passwords", () => {
    for (const token of [undefined, " ", "replace-with-token", "token\nwith-newline", "a".repeat(513)]) {
      assert.throws(() => validateGitHubToken(token), /GitHub Token/);
    }
    for (const password of [undefined, "short", "a".repeat(129), " ".repeat(20)]) {
      assert.throws(() => validatePassword(password), /管理密码/);
    }
    assert.equal(validateGitHubToken(GITHUB_TOKEN), GITHUB_TOKEN);
    assert.equal(validatePassword(PASSWORD), PASSWORD);
  });
});
