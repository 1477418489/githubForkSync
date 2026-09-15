import { ConfigurationError, validatePassword } from "./config.ts";
import { equalSecrets, hashPassword, randomToken, sha256, verifyPassword } from "./crypto.ts";
import { allowFields, HttpError } from "./http.ts";
import { readSettings } from "./storage.ts";
import type { Database, Env } from "./types.ts";

const COOKIE_NAME = "fork_sync_session";
export const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

export function sessionCookie(request: Request, token = ""): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_LIFETIME_MS / 1000 : 0}${secure}`;
}

function readSession(request: Request): string | null {
  const cookie = request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const token = cookie?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export async function authorize(db: Database, request: Request): Promise<void> {
  const token = readSession(request);
  if (!token) throw new HttpError(401, "请先登录管理面板。");
  const session = await db.prepare(`SELECT s.token_hash FROM sessions s JOIN app_settings a ON a.id = 1
    WHERE s.token_hash = ? AND s.expires_at > ? AND s.auth_version = a.auth_version`).bind(await sha256(token), Date.now()).first();
  if (!session) throw new HttpError(401, "登录已失效，请重新登录。");
}

async function checkAuthLimit(db: Database, request: Request, purpose: string): Promise<void> {
  const now = Date.now();
  const window = Math.floor(now / AUTH_WINDOW_MS);
  const expiresAt = (window + 1) * AUTH_WINDOW_MS;
  const identity = await sha256(request.headers.get("CF-Connecting-IP") ?? "local");
  const result = await db.batch([
    db.prepare("DELETE FROM auth_attempts WHERE expires_at <= ?").bind(now),
    db.prepare(`INSERT INTO auth_attempts(bucket, attempts, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`).bind(`${purpose}:${identity}:${window}`, expiresAt),
  ]);
  const attempts = result[1]?.results[0] as { attempts: number } | undefined;
  if (!attempts || attempts.attempts > 10) {
    throw new HttpError(429, "尝试次数过多，请稍后重试。", { "Retry-After": String(Math.ceil((expiresAt - now) / 1000)) });
  }
}

async function createSession(db: Database, authVersion: number): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO sessions(token_hash, auth_version, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), authVersion, now + SESSION_LIFETIME_MS),
  ]);
  return token;
}

export function requireSetupToken(env: Env): string {
  if (!env.SETUP_TOKEN || !/^[a-fA-F0-9]{64}$/.test(env.SETUP_TOKEN)) {
    throw new ConfigurationError("首次设置码尚未配置，请运行 npm run setup:token。");
  }
  return env.SETUP_TOKEN;
}

export async function setup(db: Database, request: Request, env: Env, body: Record<string, unknown>): Promise<string> {
  allowFields(body, ["setupToken", "password"]);
  if (await readSettings(db)) throw new HttpError(409, "首次设置已完成，不能重复初始化。");
  await checkAuthLimit(db, request, "setup");
  const expected = requireSetupToken(env);
  if (typeof body.setupToken !== "string" || body.setupToken.length > 256 || !await equalSecrets(expected, body.setupToken)) {
    throw new HttpError(401, "首次设置码不正确。");
  }
  let password;
  try { password = validatePassword(body.password); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  const hash = await hashPassword(password);
  // 主键和条件插入保证两个并发设置请求中只有一个能成为管理员。
  const result = await db.prepare(`INSERT INTO app_settings(id, password_hash, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO NOTHING`).bind(hash, new Date().toISOString()).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "首次设置已完成，请使用已设置的密码登录。");
  return createSession(db, 1);
}

export async function login(db: Database, request: Request, body: Record<string, unknown>): Promise<string> {
  allowFields(body, ["password"]);
  const settings = await readSettings(db);
  if (!settings) throw new HttpError(409, "请先完成首次设置。");
  await checkAuthLimit(db, request, "login");
  if (typeof body.password !== "string" || body.password.length > 128 ||
      !await verifyPassword(body.password, settings.password_hash)) {
    throw new HttpError(401, "管理密码不正确。");
  }
  return createSession(db, settings.auth_version);
}

export async function logout(db: Database, request: Request): Promise<void> {
  const token = readSession(request);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}
