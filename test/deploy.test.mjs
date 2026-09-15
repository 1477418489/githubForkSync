import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLACEHOLDER_DATABASE_ID, runDeployment } from "../scripts/deploy.mjs";

const DATABASE_ID = "12345678-1234-1234-1234-123456789abc";
const KEY = "a".repeat(64);
const SETUP = "b".repeat(64);

function fixture({ initialized = false, existingDatabase = false, bound = false, secrets = [], fail } = {}) {
  const config = { name: "github-fork-sync", d1_databases: [{
    binding: "DB", database_name: "github-fork-sync",
    database_id: bound ? DATABASE_ID : PLACEHOLDER_DATABASE_ID,
    migrations_dir: "migrations",
  }] };
  const calls = [];
  const logs = [];
  const saved = [];
  const secretNames = new Set(secrets);
  let exists = existingDatabase;
  let generated = 0;
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    const command = args.slice(0, 2).join(" ");
    if (command === fail || args[0] === fail) throw new Error("Simulated command failure");
    if (command === "d1 list") return JSON.stringify(exists ? [{ name: "github-fork-sync", uuid: DATABASE_ID }] : []);
    if (command === "d1 create") { exists = true; return ""; }
    if (command === "d1 migrations" || args[0] === "deploy") return "";
    if (command === "d1 execute") return JSON.stringify([{ success: true, results: [{ initialized: initialized ? 1 : 0 }] }]);
    if (command === "secret list") return JSON.stringify([...secretNames].map((name) => ({ name, type: "secret_text" })));
    if (command === "secret put") { secretNames.add(args[2]); return ""; }
    throw new Error("Unexpected command " + args.join(" "));
  };
  return {
    calls, logs, saved,
    options: { config, run, saveConfig: async (value) => saved.push(structuredClone(value)),
      log: (message) => logs.push(message), randomSecret: () => generated++ === 0 ? KEY : SETUP },
  };
}

const puts = (state) => state.calls.filter(({ args }) => args[0] === "secret" && args[1] === "put");

describe("D1 deployment initialization", () => {
  it("creates and binds a database, migrates before publishing and sends secrets only over stdin", async () => {
    const state = fixture();
    await runDeployment({ ...state.options, showSetupToken: true });
    assert.equal(state.saved[0].d1_databases[0].database_id, DATABASE_ID);
    const commands = state.calls.map(({ args }) => args.slice(0, 2).join(" "));
    assert.ok(commands.indexOf("d1 migrations") < commands.indexOf("deploy"));
    assert.ok(commands.indexOf("d1 execute") < commands.indexOf("deploy"));
    assert.deepEqual(puts(state), [
      { args: ["secret", "put", "ENCRYPTION_KEY"], options: { input: KEY + "\n" } },
      { args: ["secret", "put", "SETUP_TOKEN"], options: { input: SETUP + "\n" } },
    ]);
    assert.ok(!JSON.stringify(state.saved).includes(KEY));
    assert.ok(!JSON.stringify(state.calls.map(({ args }) => args)).includes(KEY));
    assert.ok(!state.logs.join("\n").includes(KEY));
    assert.ok(state.logs.join("\n").includes(SETUP));
  });

  it("keeps setup codes and encryption keys out of CI output", async () => {
    const state = fixture();
    await runDeployment(state.options);
    assert.equal(puts(state).length, 2);
    for (const secret of [KEY, SETUP]) assert.ok(!state.logs.join("\n").includes(secret));
    assert.match(state.logs.join("\n"), /npm run setup:token/);
  });

  it("reuses a database by name when the local config still contains the placeholder", async () => {
    const state = fixture({ existingDatabase: true, secrets: ["ENCRYPTION_KEY", "SETUP_TOKEN"] });
    await runDeployment(state.options);
    assert.ok(!state.calls.some(({ args }) => args[1] === "create"));
    assert.equal(state.saved[0].d1_databases[0].database_id, DATABASE_ID);
    assert.equal(puts(state).length, 0);
  });

  it("preserves existing initialized data and secrets on redeployment", async () => {
    const state = fixture({ initialized: true, bound: true, secrets: ["ENCRYPTION_KEY"] });
    await runDeployment(state.options);
    assert.equal(state.saved.length, 0);
    assert.equal(puts(state).length, 0);
    assert.ok(!state.calls.some(({ args }) => args[1] === "create" || args[1] === "list" && args[0] === "d1"));
    const queries = state.calls.filter(({ args }) => args[1] === "execute");
    assert.equal(queries.length, 1);
    assert.ok(queries[0].args.includes("SELECT COUNT(*) AS initialized FROM app_settings"));
  });

  it("refuses to replace a missing encryption key when a database has an administrator", async () => {
    const state = fixture({ initialized: true, bound: true, secrets: ["SETUP_TOKEN"] });
    await assert.rejects(runDeployment(state.options), /恢复原密钥/);
    assert.equal(puts(state).length, 0);
    assert.ok(!state.calls.some(({ args }) => args[0] === "deploy"));
  });

  it("stops before publishing or writing secrets when migrations fail", async () => {
    const state = fixture({ bound: true, fail: "d1 migrations" });
    await assert.rejects(runDeployment(state.options), /Simulated/);
    assert.ok(!state.calls.some(({ args }) => args[0] === "deploy"));
    assert.equal(puts(state).length, 0);
  });

  it("stops after a failed publication without uploading secrets", async () => {
    const state = fixture({ bound: true, fail: "deploy" });
    await assert.rejects(runDeployment(state.options), /Simulated/);
    assert.equal(puts(state).length, 0);
  });

  it("fails closed on an unexpected Cloudflare JSON response", async () => {
    const state = fixture({ bound: true });
    const originalRun = state.options.run;
    const run = (args, options) => args[1] === "execute" ? "{}" : originalRun(args, options);
    await assert.rejects(runDeployment({ ...state.options, run }), /无法确认数据库初始化状态/);
    assert.equal(puts(state).length, 0);
    assert.ok(!state.calls.some(({ args }) => args[0] === "deploy"));
  });

  it("only rotates an uninitialized application's setup code from a local terminal", async () => {
    const state = fixture({ bound: true, secrets: ["ENCRYPTION_KEY", "SETUP_TOKEN"] });
    await runDeployment({ ...state.options, setupTokenOnly: true, showSetupToken: true });
    assert.deepEqual(puts(state).map(({ args }) => args[2]), ["SETUP_TOKEN"]);
    assert.ok(!state.calls.some(({ args }) => args[0] === "deploy" || args[1] === "migrations"));
    assert.ok(state.logs.join("\n").includes(KEY));
  });

  it("does not rotate setup codes in CI or repurpose them to reset an existing administrator", async () => {
    const ci = fixture({ bound: true });
    await assert.rejects(runDeployment({ ...ci.options, setupTokenOnly: true }), /本地交互终端/);
    assert.equal(ci.calls.length, 0);
    const initialized = fixture({ initialized: true, bound: true, secrets: ["ENCRYPTION_KEY"] });
    await assert.rejects(runDeployment({ ...initialized.options, setupTokenOnly: true, showSetupToken: true }), /不能重置/);
    assert.equal(puts(initialized).length, 0);
  });

  it("does not print a generated setup code if uploading it fails", async () => {
    const state = fixture({ bound: true, secrets: ["ENCRYPTION_KEY"], fail: "secret put" });
    await assert.rejects(runDeployment({ ...state.options, setupTokenOnly: true, showSetupToken: true }), /Simulated/);
    assert.ok(!state.logs.join("\n").includes(KEY));
  });
});
