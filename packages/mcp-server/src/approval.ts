/**
 * Approval tokens: the bridge between a decision in a Camunda process (a person in Slack, or a policy that allows
 * automatic action) and a write in a business system.
 *
 * A token names one tool and the hash of its exact arguments, so an agent cannot get an approval for one write and
 * use it for another, or change an argument after a person said yes. It carries who approved and expires. Each token
 * is used once: a repeated call with the same token returns the first result instead of writing again.
 */
import { canonical, hmac, randomId, safeEqual, sha256 } from "@revops/core";

export interface ApprovalClaims {
  tool: string;
  argsHash: string;
  instance: string; // process instance key (or another subject) the approval belongs to
  approvedBy: string; // "U012345 (Slack)", "policy:auto-route"
  iat: number;
  exp: number;
  jti: string;
}

export function argsHash(args: Record<string, unknown>): string {
  const { approval_token: _ignored, ...rest } = args;
  return sha256(canonical(rest));
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

export function mintApproval(secret: string, c: Omit<ApprovalClaims, "iat" | "exp" | "jti"> & { ttlSeconds: number; nowMs?: number }): string {
  const now = Math.floor((c.nowMs ?? Date.now()) / 1000);
  const claims: ApprovalClaims = { tool: c.tool, argsHash: c.argsHash, instance: c.instance, approvedBy: c.approvedBy, iat: now, exp: now + c.ttlSeconds, jti: randomId("apv_") };
  const body = b64(JSON.stringify(claims));
  return `v1.${body}.${hmac(secret, `v1.${body}`, "base64url")}`;
}

export type ApprovalCheck = { ok: true; claims: ApprovalClaims } | { ok: false; reason: string };

export function verifyApproval(secret: string, token: string | undefined, tool: string, args: Record<string, unknown>, nowMs = Date.now()): ApprovalCheck {
  if (!token) return { ok: false, reason: "approval_required" };
  const [v, body, sig] = token.split(".");
  if (v !== "v1" || !body || !sig) return { ok: false, reason: "malformed approval token" };
  if (!safeEqual(hmac(secret, `v1.${body}`, "base64url"), sig)) return { ok: false, reason: "approval signature invalid" };
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as ApprovalClaims;
  if (claims.tool !== tool) return { ok: false, reason: `approval is for ${claims.tool}, not ${tool}` };
  if (claims.argsHash !== argsHash(args)) return { ok: false, reason: "arguments differ from what was approved" };
  if (claims.exp * 1000 < nowMs) return { ok: false, reason: "approval expired" };
  return { ok: true, claims };
}
