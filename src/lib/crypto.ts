import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./db";

/**
 * Credentials are encrypted at rest with AES-256-GCM. The key comes from
 * BROADSIDE_SECRET, or from a key file created on first run beside the
 * database (mode 0600). Losing the key means reconnecting accounts.
 */
function key(): Buffer {
  const fromEnv = process.env.BROADSIDE_SECRET;
  if (fromEnv) return createHash("sha256").update(fromEnv).digest();
  const file = path.join(dataDir(), "secret.key");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function open<T>(sealed: string): T {
  const [iv, tag, body] = sealed.split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as T;
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const newId = (prefix: string): string => `${prefix}_${randomBytes(9).toString("base64url")}`;

export const newToken = (): string => `bs_${randomBytes(24).toString("base64url")}`;
