import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PLACEHOLDER_DATABASE_ID, runDeployment } from "../scripts/deploy.mjs";

const DATABASE_ID = "12345678-1234-1234-1234-123456789abc";
const KEY = "a".repeat(64);
const SETUP = "b".repeat(64);

function fixture({ initialized = false, existingDatabase = false, bound = false, secrets = [], fail, randomSecrets = [KEY, SETUP] } = {}) {
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
      log: (message) => logs.push(message), randomSecret: () => {
        const secret = randomSecrets[generated++];
        assert.ok(secret, "Unexpected secret generation");
        return secret;
      } },
  };
}

const puts = (state) => state.calls.filter(({ args }) => args[0] === "secret" && args[1] === "put");

describe("D1 deployment initialization", () => {
  it("creates and binds a database, migrates before publishing and sends secrets only over stdin", async () => {
    const state = fixture();
    await runDeployment(state.options);
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

  it("prints the setup code by default while keeping the encryption key private", async () => {
    const state = fixture();
    await runDeployment(state.options);
    assert.equal(puts(state).length, 2);
    assert.ok(!state.logs.join("\n").includes(KEY));
    assert.ok(state.logs.join("\n").includes("首次设置码（SETUP_TOKEN） ==========\n" + SETUP + "\n"));
    assert.ok(!JSON.stringify(state.calls.map(({ args }) => args)).includes(SETUP));
    assert.ok(!JSON.stringify(state.saved).includes(SETUP));
  });

  it("reuses a database by name when the local config still contains the placeholder", async () => {
    const state = fixture({ existingDatabase: true, secrets: ["ENCRYPTION_KEY", "SETUP_TOKEN"], randomSecrets: [SETUP] });
    await runDeployment(state.options);
    assert.ok(!state.calls.some(({ args }) => args[1] === "create"));
    assert.equal(state.saved[0].d1_databases[0].database_id, DATABASE_ID);
    assert.deepEqual(puts(state), [
      { args: ["secret", "put", "SETUP_TOKEN"], options: { input: SETUP + "\n" } },
    ]);
    assert.ok(state.logs.join("\n").includes(SETUP));
  });

  it("reissues an existing hidden setup code on each deployment until initialization", async () => {
    const replacement = "c".repeat(64);
    const state = fixture({ bound: true, secrets: ["ENCRYPTION_KEY", "SETUP_TOKEN"], randomSecrets: [SETUP, replacement] });
    await runDeployment(state.options);
    await runDeployment(state.options);
    assert.deepEqual(puts(state).map(({ args, options }) => [args[2], options.input.trim()]), [
      ["SETUP_TOKEN", SETUP], ["SETUP_TOKEN", replacement],
    ]);
    const output = state.logs.join("\n");
    assert.ok(output.includes(SETUP));
    assert.ok(output.includes(replacement));
    assert.ok(!output.includes(KEY));
  });

  it("preserves existing initialized data and secrets on redeployment", async () => {
    const state = fixture({ initialized: true, bound: true, secrets: ["ENCRYPTION_KEY", "SETUP_TOKEN"] });
    await runDeployment(state.options);
    assert.equal(state.saved.length, 0);
    assert.equal(puts(state).length, 0);
    assert.ok(!state.logs.join("\n").includes("首次设置码"));
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

  it("rotates only the setup code without migrating or deploying", async () => {
    const state = fixture({ bound: true, secrets: ["ENCRYPTION_KEY", "SETUP_TOKEN"], randomSecrets: [SETUP] });
    await runDeployment({ ...state.options, setupTokenOnly: true });
    assert.deepEqual(puts(state).map(({ args }) => args[2]), ["SETUP_TOKEN"]);
    assert.ok(!state.calls.some(({ args }) => args[0] === "deploy" || args[1] === "migrations"));
    assert.ok(state.logs.join("\n").includes(SETUP));
    assert.ok(!state.logs.join("\n").includes(KEY));
  });

  it("requires a bound database for setup-only mode", async () => {
    const state = fixture();
    await assert.rejects(runDeployment({ ...state.options, setupTokenOnly: true }), /数据库尚未绑定/);
    assert.equal(state.calls.length, 0);
  });

  it("does not repurpose setup codes to reset an existing administrator", async () => {
    const initialized = fixture({ initialized: true, bound: true, secrets: ["ENCRYPTION_KEY"] });
    await assert.rejects(runDeployment({ ...initialized.options, setupTokenOnly: true }), /不能重置/);
    assert.equal(puts(initialized).length, 0);
  });

  it("does not print a generated setup code if uploading it fails", async () => {
    for (const setupTokenOnly of [false, true]) {
      const state = fixture({ bound: true, secrets: ["ENCRYPTION_KEY"], fail: "secret put", randomSecrets: [SETUP] });
      await assert.rejects(runDeployment({ ...state.options, setupTokenOnly }), /Simulated/);
      assert.ok(!state.logs.join("\n").includes(SETUP));
      assert.ok(!state.logs.join("\n").includes("首次设置码（SETUP_TOKEN）"));
    }
  });

  it("prints the uploaded setup code through the CLI in CI with piped stdout", (t) => {
    const parent = resolve(tmpdir());
    const root = mkdtempSync(join(parent, "fork-sync-deploy-cli-"));
    t.after(() => {
      const target = resolve(root);
      assert.equal(dirname(target), parent);
      assert.ok(basename(target).startsWith("fork-sync-deploy-cli-"));
      rmSync(target, { recursive: true, force: true });
    });
    // 独立目录中的 Wrangler/TypeScript 替身只验证真实 CLI 的输出和 stdin，不连接 Cloudflare。
    const files = {
      "package.json": JSON.stringify({ type: "module" }),
      "wrangler.jsonc": JSON.stringify(fixture({ bound: true }).options.config),
      "scripts/deploy.mjs": readFileSync(new URL("../scripts/deploy.mjs", import.meta.url), "utf8"),
      "node_modules/typescript/package.json": JSON.stringify({ type: "module", main: "index.js" }),
      "node_modules/typescript/index.js": "export default { parseConfigFileTextToJson: (_, text) => ({ config: JSON.parse(text) }) };",
      "node_modules/wrangler/bin/wrangler.js": [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const [command, action, name] = process.argv.slice(2);',
        'if (command === "d1" && action === "execute") console.log(JSON.stringify([{ success: true, results: [{ initialized: 0 }] }]));',
        'else if (command === "secret" && action === "list") console.log(JSON.stringify([{ name: "ENCRYPTION_KEY" }, { name: "SETUP_TOKEN" }]));',
        'else if (command === "secret" && action === "put" && name === "SETUP_TOKEN") writeFileSync("issued-setup-token.txt", readFileSync(0, "utf8"));',
        'else if (command !== "deploy" && !(command === "d1" && action === "migrations")) throw new Error("Unexpected Wrangler command");',
      ].join("\n"),
    };
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const codes = [];
    for (const args of [[], ["--setup-token"]]) {
      const result = spawnSync(process.execPath, [join(root, "scripts/deploy.mjs"), ...args], {
        cwd: root, encoding: "utf8", timeout: 15_000,
        env: { ...process.env, CI: "true", WORKERS_CI: "1", GITHUB_ACTIONS: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(result.status, 0, result.stderr);
      const match = result.stdout.match(/首次设置码（SETUP_TOKEN） ==========\r?\n([a-f0-9]{64})\r?\n/);
      assert.ok(match, result.stdout);
      assert.equal(readFileSync(join(root, "issued-setup-token.txt"), "utf8").trim(), match[1]);
      codes.push(match[1]);
    }
    assert.notEqual(codes[0], codes[1]);
  });
});
