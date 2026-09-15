import { ConfigurationError } from "./config.ts";

const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 100_000;
const TOKEN_CONTEXT = encoder.encode("fork-sync:github-token:v1");

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function requireEncryptionKey(value: string | undefined): string {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new ConfigurationError("部署未完成：缺少有效的 ENCRYPTION_KEY，请运行 npm run deploy。");
  }
  return value;
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function equalSecrets(left: string, right: string): Promise<boolean> {
  const digests = await Promise.all([left, right].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return equalBytes(new Uint8Array(digests[0]!), new Uint8Array(digests[1]!));
}

async function passwordBits(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `v1.${base64(salt)}.${base64(await passwordBits(password, salt))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [version, salt, hash, extra] = stored.split(".");
  if (version !== "v1" || !salt || !hash || extra !== undefined) return false;
  try {
    const decodedSalt = unbase64(salt);
    const decodedHash = unbase64(hash);
    if (decodedSalt.length !== 16 || decodedHash.length !== 32) return false;
    return equalBytes(await passwordBits(password, decodedSalt), decodedHash);
  } catch { return false; }
}

async function aesKey(value: string): Promise<CryptoKey> {
  const encoded = requireEncryptionKey(value);
  const bytes = Uint8Array.from(encoded.match(/.{2}/g)!, (hex) => parseInt(hex, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(token: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: TOKEN_CONTEXT }, await aesKey(key), encoder.encode(token));
  return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}

export async function decryptToken(stored: string, key: string): Promise<string> {
  try {
    const [version, iv, ciphertext, extra] = stored.split(".");
    if (version !== "v1" || !iv || !ciphertext || extra !== undefined) throw new Error("Invalid ciphertext");
    const decodedIv = unbase64(iv);
    if (decodedIv.length !== 12) throw new Error("Invalid IV");
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodedIv, additionalData: TOKEN_CONTEXT }, await aesKey(key), unbase64(ciphertext));
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new ConfigurationError("GitHub Token 解密失败，请检查 ENCRYPTION_KEY 是否被更换，或在页面重新保存 Token。");
  }
}
