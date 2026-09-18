import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryableRepositories } from "../public/sync-options.js";

describe("failed repository selection", () => {
  it("keeps unresolved failures from partial runs and ignores later configuration checks", () => {
    const repositories = [
      { repository: "alice/failed", autoSync: false }, { repository: "alice/recovered" },
      { repository: "alice/skipped" }, { repository: "alice/new" },
    ];
    const reports = [
      { dryRun: true, results: repositories.map((target) => ({ ...target, status: "checked" })) },
      { dryRun: false, results: [{ repository: "alice/recovered", status: "up_to_date" }] },
      { dryRun: false, results: [
        { repository: "ALICE/FAILED", status: "failed" }, { repository: "alice/recovered", status: "failed" },
        { repository: "alice/skipped", status: "skipped" }, { repository: "alice/removed", status: "failed" },
      ] },
    ];
    assert.deepEqual(retryableRepositories(repositories, reports).map((target) => target.repository), ["alice/failed", "alice/skipped"]);
  });

  it("does not retry a different explicit branch or a repository with no actual sync history", () => {
    const repositories = [{ repository: "alice/project", branch: "release" }, { repository: "alice/unchecked" }];
    const reports = [
      { dryRun: true, results: [{ repository: "alice/unchecked", status: "failed" }] },
      { dryRun: false, results: [{ repository: "alice/project", branch: "main", status: "failed" }] },
    ];
    assert.deepEqual(retryableRepositories(repositories, reports), []);
    assert.deepEqual(retryableRepositories(repositories, []), []);
  });
});
