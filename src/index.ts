import { authorize, login, logout, requireSetupToken, sessionCookie, setup } from "./auth.ts";
import { ConfigurationError, parseSyncOptions } from "./config.ts";
import { requireEncryptionKey } from "./crypto.ts";
import { checkOrigin, HttpError, json, readObject } from "./http.ts";
import { executeSync } from "./service.ts";
import { database, publicSettings, readSettings, saveSettings } from "./storage.ts";
import type { Env } from "./types.ts";

const routes: Record<string, string[]> = {
  "/healthz": ["GET"], "/api/status": ["GET"], "/api/setup": ["POST"],
  "/api/login": ["POST"], "/api/logout": ["POST"], "/api/config": ["GET", "PUT"], "/api/sync": ["POST"],
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const methods = routes[path];
    if (!methods) {
      if (path === "/api" || path.startsWith("/api/")) return json({ error: "接口不存在。" }, 404);
      return env.ASSETS.fetch(request);
    }
    if (!methods.includes(request.method)) return json({ error: "请求方法不支持。" }, 405, { Allow: methods.join(", ") });
    if (path === "/healthz") return json({ ok: true, service: "github-fork-sync" });

    try {
      checkOrigin(request);
      requireEncryptionKey(env.ENCRYPTION_KEY);
      const db = database(env);
      if (path === "/api/status") {
        const initialized = Boolean(await readSettings(db));
        if (!initialized) requireSetupToken(env);
        return json({ initialized });
      }
      if (path === "/api/setup" || path === "/api/login") {
        const body = await readObject(request, 2048);
        const token = path === "/api/setup" ? await setup(db, request, env, body) : await login(db, request, body);
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, token) });
      }
      if (path === "/api/logout") {
        await logout(db, request);
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request) });
      }
      await authorize(db, request);
      if (path === "/api/config") {
        if (request.method === "GET") return json(await publicSettings(db));
        const config = await saveSettings(db, env, await readObject(request));
        return json(config, 200, config.reloginRequired ? { "Set-Cookie": sessionCookie(request) } : {});
      }
      let options;
      try { options = parseSyncOptions(await readObject(request, 4096, true)); }
      catch (error) {
        if (error instanceof ConfigurationError) throw new HttpError(400, error.message);
        throw error;
      }
      const report = await executeSync(env, "manual", options);
      return json(report, report?.ok ? 200 : 502);
    } catch (error) {
      if (error instanceof ConfigurationError) return json({ error: error.message }, 503);
      if (error instanceof HttpError) return json({ error: error.message }, error.status, error.headers);
      console.error(JSON.stringify({ event: "fork_sync_internal_error", path }));
      return json({ error: "服务内部错误，请查看 Cloudflare 日志。" }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const report = await executeSync(env, "scheduled", {}, controller.scheduledTime);
    if (report && !report.ok) {
      throw new Error("同步失败：" + report.summary.failed + " 个失败，" + report.summary.skipped + " 个跳过；runId=" + report.runId);
    }
  },
} satisfies ExportedHandler<Env>;
