/**
 * The three services the workers talk to: Camunda (Orchestration Cluster REST API), the GTM MCP server and the
 * agent service. Every GTM read and write goes through the MCP server, so the workers hold no Salesforce,
 * Gainsight or Impartner credentials and every change is approved, idempotent and audited in one place.
 */
import { type CamundaClient, createCamundaClient } from "@camunda8/orchestration-cluster-api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Camunda: locally the engine in this repository (no auth); in production a Camunda 8.8 cluster with OAuth client
 * credentials (CAMUNDA_AUTH_STRATEGY=OAUTH, CAMUNDA_CLIENT_ID, CAMUNDA_CLIENT_SECRET, CAMUNDA_OAUTH_URL, ZEEBE_TOKEN_AUDIENCE).
 */
export function camunda(restAddress = process.env.CAMUNDA_REST_ADDRESS ?? "http://127.0.0.1:8088/v2"): CamundaClient {
  return createCamundaClient({
    config: {
      CAMUNDA_REST_ADDRESS: restAddress,
      CAMUNDA_AUTH_STRATEGY: process.env.CAMUNDA_AUTH_STRATEGY ?? "NONE",
      CAMUNDA_SDK_LOG_LEVEL: process.env.CAMUNDA_SDK_LOG_LEVEL ?? "silent",
    } as never,
  });
}

export class ToolCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  /** Errors another attempt may fix (an upstream outage, a lock, the API budget reserve). */
  get retryable(): boolean {
    return [
      "NETWORK",
      "SERVER_UNAVAILABLE",
      "UNABLE_TO_LOCK_ROW",
      "API_BUDGET_RESERVED",
      "HTTP_503",
      "HTTP_502",
      "HTTP_500",
      "CIRCUIT_OPEN",
      "internal_error",
      "ratelimited",
      "HTTP_429",
      "RATE_LIMITED",
    ].includes(this.code);
  }
}

/** The GTM MCP server, as the orchestrator client (a token with gtm:read, gtm:pii and gtm:write). */
export class McpGateway {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const c = new Client({ name: "revops-orchestrator", version: "0.1.0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { authorization: `Bearer ${this.token}` } } }));
      this.client = c;
      return c;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown>): Promise<T> {
    const c = await this.connect();
    let r: CallToolResult;
    try {
      r = (await c.callTool({ name: tool, arguments: args })) as CallToolResult;
    } catch (e) {
      this.client = null; // reconnect next time
      throw new ToolCallError("NETWORK", (e as Error).message);
    }
    if (r.isError) {
      const s = (r.structuredContent ?? {}) as { error?: string; message?: string };
      throw new ToolCallError(s.error ?? "error", s.message ?? JSON.stringify(r.content));
    }
    return r.structuredContent as T;
  }

  async listTools() {
    const c = await this.connect();
    return (await c.listTools()).tools;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

export class AgentServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The Python agent service (Cloud Run, service token). */
export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new AgentServiceError(0, "NETWORK", (e as Error).message);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = `HTTP_${res.status}`;
      try {
        code = (JSON.parse(text) as { code?: string }).code ?? code;
      } catch {
        /* not JSON */
      }
      throw new AgentServiceError(res.status, code, text.slice(0, 300));
    }
    return JSON.parse(text) as T;
  }
}
