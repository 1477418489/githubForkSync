import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const INITIALIZED_QUERY = "SELECT COUNT(*) AS initialized FROM app_settings";

function dbBinding(config) {
  const bindings = config.d1_databases?.filter((binding) => binding.binding === "DB");
  if (!config.name || bindings?.length !== 1) throw new Error("wrangler.jsonc 必须配置 Worker name 和唯一的 D1 DB 绑定。");
  const binding = bindings[0];
  if (typeof binding.database_name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(binding.database_name)) {
    throw new Error("DB.database_name 必须由字母、数字、下划线或连字符组成。");
  }
  if (!UUID.test(binding.database_id ?? "")) throw new Error("DB.database_id 必须是数据库 UUID；首次部署请保留全零占位值。");
  return binding;
}

function parseJson(output, command) {
  try { return JSON.parse(output); }
  catch { throw new Error(`${command} 未返回有效 JSON，部署已停止。`); }
}

async function listDatabases(run) {
  const value = parseJson(await run(["d1", "list", "--json"], { capture: true }), "wrangler d1 list");
  if (!Array.isArray(value) || value.some((db) => !db || typeof db.name !== "string" || !UUID.test(db.uuid))) {
    throw new Error("Cloudflare 返回了无法识别的数据库列表。");
  }
  return value;
}

async function isInitialized(run) {
  const value = parseJson(await run(["d1", "execute", "DB", "--remote", "--command", INITIALIZED_QUERY, "--json"], { capture: true }), "wrangler d1 execute");
  const count = value?.[0]?.results?.[0]?.initialized;
  if (!Array.isArray(value) || value.length !== 1 || value[0].success === false || ![0, 1].includes(count)) {
    throw new Error("无法确认数据库初始化状态，部署已停止。");
  }
  return count === 1;
}

async function listSecrets(run) {
  const value = parseJson(await run(["secret", "list", "--format", "json"], { capture: true }), "wrangler secret list");
  if (!Array.isArray(value) || value.some((secret) => !secret || typeof secret.name !== "string")) {
    throw new Error("Cloudflare 返回了无法识别的 Secret 列表。");
  }
  return new Set(value.map((secret) => secret.name));
}

function requireExistingKey(secrets) {
  if (!secrets.has("ENCRYPTION_KEY")) {
    throw new Error("D1 已有管理员，但 Worker 缺少 ENCRYPTION_KEY。请检查账号、Worker 名称和数据库绑定，并恢复原密钥；脚本不会生成新密钥覆盖已有数据。");
  }
}

// 依赖注入用于验证真实部署的顺序、失败处理和凭据传递；测试不访问 Cloudflare。
export async function runDeployment({ config, run, saveConfig, log = console.log,
  randomSecret = () => randomBytes(32).toString("hex"), showSetupToken = false, setupTokenOnly = false }) {
  const binding = dbBinding(config);
  if (setupTokenOnly && !showSetupToken) {
    throw new Error("请在本地交互终端运行 npm run setup:token；设置码不会写入 CI 日志或重定向输出。");
  }
  if (setupTokenOnly && binding.database_id === PLACEHOLDER_DATABASE_ID) {
    throw new Error("数据库尚未绑定，请先运行 npm run deploy。");
  }

  if (binding.database_id === PLACEHOLDER_DATABASE_ID) {
    let found = (await listDatabases(run)).find((db) => db.name === binding.database_name);
    if (!found) {
      log(`创建 D1 数据库：${binding.database_name}`);
      await run(["d1", "create", binding.database_name, "--update-config=false"]);
      found = (await listDatabases(run)).find((db) => db.name === binding.database_name);
    }
    if (!found) throw new Error("数据库创建后未出现在列表中，请稍后重新运行 npm run deploy。");
    binding.database_id = found.uuid;
    await saveConfig(config);
    log("D1 数据库 ID 已写入 wrangler.jsonc；该 ID 不属于凭据，可以提交到仓库。");
  }

  if (!setupTokenOnly) await run(["d1", "migrations", "apply", "DB", "--remote"]);
  const initialized = await isInitialized(run);
  if (setupTokenOnly) {
    if (initialized) throw new Error("首次设置已完成，设置码已失效。此命令不能重置管理员密码。");
    if (!(await listSecrets(run)).has("ENCRYPTION_KEY")) throw new Error("缺少 ENCRYPTION_KEY，请先运行 npm run deploy 完成部署。");
    const token = randomSecret();
    await run(["secret", "put", "SETUP_TOKEN"], { input: token + "\n" });
    log("首次设置码已更新，旧设置码立即失效：\n" + token);
    return;
  }

  // 已初始化的数据库绝不能配上新的随机密钥；在发布前先检查一次。
  if (initialized) requireExistingKey(await listSecrets(run));
  await run(["deploy"]);
  const secrets = await listSecrets(run);
  if (!secrets.has("ENCRYPTION_KEY")) {
    if (initialized) requireExistingKey(secrets);
    await run(["secret", "put", "ENCRYPTION_KEY"], { input: randomSecret() + "\n" });
    log("加密密钥已保存到 Cloudflare Workers Secret。");
  }
  if (!initialized && !secrets.has("SETUP_TOKEN")) {
    const token = randomSecret();
    await run(["secret", "put", "SETUP_TOKEN"], { input: token + "\n" });
    if (showSetupToken) log("首次设置码（用于网页创建管理员，请妥善保存）：\n" + token);
    else log("首次设置码已保存到 Cloudflare；请在本地终端运行 npm run setup:token 获取新的设置码。");
  } else if (!initialized) {
    log("已有首次设置码。若已遗失，请在本地终端运行 npm run setup:token。");
  }
  log(initialized ? "部署完成，已有页面配置和密钥已保留。" : "部署完成。打开 Worker 地址，使用首次设置码创建管理员，然后在页面填写同步设置。");
}

function wranglerRunner(root) {
  const executable = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  return async (args, { capture = false, input } = {}) => {
    const privateInput = input !== undefined;
    const piped = capture || privateInput;
    return new Promise((complete, reject) => {
      const child = spawn(process.execPath, [executable, ...args, "--config", resolve(root, "wrangler.jsonc")], {
        cwd: root,
        shell: false,
        env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
        stdio: [privateInput ? "pipe" : "ignore", piped ? "pipe" : "inherit", piped ? "pipe" : "inherit"],
      });
      let output = "";
      let errors = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) complete(output);
        else {
          // Secret 写入失败时也不转发子进程输出，避免第三方错误文本带出凭据。
          const detail = !privateInput && errors.trim() ? "\n" + errors.trim() : "";
          reject(new Error(`wrangler ${args.slice(0, 3).join(" ")} 执行失败（退出码 ${code}）。${detail}`));
        }
      });
      if (privateInput) {
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      }
    });
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--setup-token")) {
    throw new Error("用法：npm run deploy 或 npm run setup:token。部署脚本使用 wrangler.jsonc 的默认环境。");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try { await access(resolve(root, "node_modules/wrangler/bin/wrangler.js")); }
  catch { throw new Error("缺少部署依赖，请先运行 npm install。"); }
  const ts = (await import("typescript")).default;
  const configPath = resolve(root, "wrangler.jsonc");
  const { config, error } = ts.parseConfigFileTextToJson(configPath, await readFile(configPath, "utf8"));
  if (error) throw new Error("wrangler.jsonc 格式错误：" + ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  await runDeployment({
    config,
    run: wranglerRunner(root),
    saveConfig: (value) => writeFile(configPath, JSON.stringify(value, null, 2) + "\n"),
    showSetupToken: Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && !process.env.GITHUB_ACTIONS),
    setupTokenOnly: args[0] === "--setup-token",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
