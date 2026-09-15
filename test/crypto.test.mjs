import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decryptToken, encryptToken, hashPassword, requireEncryptionKey, verifyPassword } from "../src/crypto.ts";
import { ENCRYPTION_KEY, GITHUB_TOKEN, PASSWORD } from "./helpers.mjs";

describe("credential storage", () => {
  it("encrypts the same token with a fresh IV on each save", async () => {
    const first = await encryptToken(GITHUB_TOKEN, ENCRYPTION_KEY);
    const second = await encryptToken(GITHUB_TOKEN, ENCRYPTION_KEY);
    assert.notEqual(first, second);
    assert.ok(!first.includes(GITHUB_TOKEN));
    assert.equal(await decryptToken(first, ENCRYPTION_KEY), GITHUB_TOKEN);
    assert.equal(await decryptToken(second, ENCRYPTION_KEY), GITHUB_TOKEN);
  });

  it("rejects tampered ciphertext and the wrong encryption key", async () => {
    const encrypted = await encryptToken(GITHUB_TOKEN, ENCRYPTION_KEY);
    await assert.rejects(decryptToken(encrypted, "f".repeat(64)), /解密失败/);
    const parts = encrypted.split(".");
    const bytes = Buffer.from(parts[2], "base64");
    bytes[0] ^= 1;
    parts[2] = bytes.toString("base64");
    await assert.rejects(decryptToken(parts.join("."), ENCRYPTION_KEY), /解密失败/);
  });

  it("stores salted password hashes and verifies only the correct password", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    assert.notEqual(first, second);
    assert.ok(!first.includes(PASSWORD));
    assert.equal(await verifyPassword(PASSWORD, first), true);
    assert.equal(await verifyPassword("wrong-password", first), false);
    assert.equal(await verifyPassword(PASSWORD, "invalid"), false);
  });

  it("never accepts a missing or malformed root key", () => {
    for (const value of [undefined, "", "short", "g".repeat(64)]) assert.throws(() => requireEncryptionKey(value));
    assert.equal(requireEncryptionKey(ENCRYPTION_KEY), ENCRYPTION_KEY);
  });
});
