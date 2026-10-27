import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

export function hmac(key: string, data: string, encoding: "hex" | "base64" | "base64url" = "hex"): string {
  return createHmac("sha256", key).update(data, "utf8").digest(encoding);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomId = (prefix = ""): string => prefix + randomBytes(9).toString("base64url");

/** Canonical JSON (sorted keys) so a hash of arguments does not depend on key order. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}
