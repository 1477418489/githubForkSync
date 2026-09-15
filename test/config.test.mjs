import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError, validatePassword, validateGitHubToken, parseRepositories } from "../src/config.ts";
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
