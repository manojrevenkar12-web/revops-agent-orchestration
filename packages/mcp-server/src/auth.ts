/**
 * Who is calling. Clients present a bearer token; the server knows only its SHA-256 (config/mcp.yaml, filled from
 * Secret Manager in production). Each client has scopes and a per-minute request allowance.
 *
 * The allowance is counted per server instance. On Cloud Run the service runs with a small max-instances, so the
 * effective ceiling is allowance x instances; that is a deliberate trade against a shared counter on every call.
 */
import { safeEqual, sha256 } from "@revops/core";
import type { Caller } from "./tools";

export interface McpClientConfig {
  token_sha256: string;
  scopes: string[];
  requests_per_minute: number;
}

export interface McpConfig {
  clients: Record<string, McpClientConfig>;
  approvals: { secret: string; max_age_seconds: number };
  limits: { max_rows: number; max_query_chars: number };
  tools: Record<string, { scope: string; approval?: "required" }>;
  allowed_origins?: string[];
}

export type AuthResult = { ok: true; caller: Caller } | { ok: false; status: 401 | 429; reason: string };

export class Authenticator {
  private windows = new Map<string, { minute: number; count: number }>();

  constructor(
    private readonly cfg: McpConfig,
    private readonly nowMs: () => number = Date.now,
  ) {}

  identify(token: string | undefined): Caller | null {
    if (!token) return null;
    const h = sha256(token);
    for (const [client, c] of Object.entries(this.cfg.clients)) {
      if (safeEqual(h, c.token_sha256)) return { client, scopes: new Set(c.scopes) };
    }
    return null;
  }

  check(authorization: string | undefined): AuthResult {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    const caller = this.identify(m?.[1]);
    if (!caller) return { ok: false, status: 401, reason: "missing or unknown bearer token" };
    const limit = this.cfg.clients[caller.client]?.requests_per_minute ?? 0;
    const minute = Math.floor(this.nowMs() / 60_000);
    const w = this.windows.get(caller.client);
    if (!w || w.minute !== minute) this.windows.set(caller.client, { minute, count: 1 });
    else if (++w.count > limit) return { ok: false, status: 429, reason: `more than ${limit} requests this minute` };
    return { ok: true, caller };
  }
}
