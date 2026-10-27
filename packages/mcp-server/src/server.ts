/**
 * The GTM MCP server over Streamable HTTP, stateless (one server object per request, no session), which is what lets
 * it scale to zero on Cloud Run and sit behind a load balancer without sticky sessions.
 *
 * It uses the SDK's low-level Server rather than McpServer so that it decides itself, before any argument parsing:
 * which tools a caller sees (an analyst token does not see write tools at all), the scope check, and the audit entry
 * for every call including refused ones.
 */
import { type Server as HttpServer, type IncomingMessage, createServer } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { CallToolRequestSchema, type CallToolResult, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Connectors, UpstreamError, buildConnectors } from "@revops/connectors";
import { AuditLog, type Clock, loadConfig, systemClock } from "@revops/core";
import { z } from "zod";
import { Authenticator, type McpConfig } from "./auth";
import { PlaybookIndex } from "./retrieval";
import { type Caller, TOOLS, type ToolContext, ToolError, runTool } from "./tools";

export const SERVER_INFO = { name: "revops-gtm", version: "0.1.0" };

/** JSON Schema for a tool's arguments (computed once per tool). */
const schemaCache = new Map<object, { type: "object"; properties?: Record<string, object> }>();
function inputSchemaOf(shape: z.ZodRawShape): { type: "object"; properties?: Record<string, object> } {
  let s = schemaCache.get(shape);
  if (!s) {
    const obj: unknown = z.object(shape).strict();
    s = toJsonSchemaCompat(obj as Parameters<typeof toJsonSchemaCompat>[0]) as { type: "object"; properties?: Record<string, object> };
    schemaCache.set(shape, s);
  }
  return s;
}

const callerOf = (auth: AuthInfo | undefined): Caller => ({ client: auth?.clientId ?? "anonymous", scopes: new Set(auth?.scopes ?? []) });

/** One MCP server object bound to the shared tool context; cheap to create per request. */
export function createMcpServer(ctx: ToolContext, fixedCaller?: Caller): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions:
      "GTM systems for Camunda's revenue team: Salesforce, Gainsight, Salesloft, Clari, Impartner, the product warehouse and the playbooks. " +
      "Read tools are safe to call. Write tools change business systems and need an approval_token issued by the orchestration process for exactly the arguments you send; without it they are refused. " +
      "When you state a fact from account_360, cite its fact id; when you rely on a playbook, cite the passage id.",
  });
  const who = (extra: { authInfo?: AuthInfo }) => fixedCaller ?? callerOf(extra.authInfo);

  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    const caller = who(extra);
    return {
      tools: TOOLS.filter((t) => caller.scopes.has(t.scope)).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.write ? `${t.description} Needs approval_token.` : t.description,
        inputSchema: inputSchemaOf(t.input),
        annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    try {
      const out = await runTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx, who(extra));
      return { content: [{ type: "text", text: out.summary }], structuredContent: out.data };
    } catch (e) {
      // Tool errors go back to the model as results it can read and act on, not as protocol errors.
      const code = e instanceof ToolError || e instanceof UpstreamError ? e.code : "internal_error";
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: { error: code, message } };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (_req, extra) => {
    if (!who(extra).scopes.has("gtm:read")) return { resources: [] };
    const docs = [...new Set(ctx.playbooks.passages.map((p) => p.doc))];
    return { resources: docs.map((d) => ({ uri: `playbook://${d}`, name: d, title: d.replace(/-/g, " "), mimeType: "text/markdown" })) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    if (!who(extra).scopes.has("gtm:read")) throw new Error("forbidden");
    const doc = req.params.uri.replace(/^playbook:\/\//, "");
    const passages = ctx.playbooks.passages.filter((p) => p.doc === doc);
    if (!passages.length) throw new Error(`no playbook ${doc}`);
    return { contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: passages.map((p) => `## ${p.heading} [${p.id}]\n\n${p.text}`).join("\n\n") }] };
  });
  return server;
}

export interface GtmMcpService {
  http: HttpServer;
  ctx: ToolContext;
  auth: Authenticator;
  cfg: McpConfig;
}

async function readBody(req: IncomingMessage, max = 1_000_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function buildToolContext(opts: { connectors?: Connectors; baseUrl?: string; audit?: AuditLog; clock?: Clock; cfg?: McpConfig } = {}): { ctx: ToolContext; cfg: McpConfig } {
  const cfg = opts.cfg ?? loadConfig<McpConfig>("mcp");
  return {
    cfg,
    ctx: {
      c: opts.connectors ?? buildConnectors({ baseUrl: opts.baseUrl }),
      playbooks: new PlaybookIndex(),
      audit: opts.audit ?? new AuditLog(),
      clock: opts.clock ?? systemClock,
      approvalSecret: cfg.approvals.secret,
      maxRows: cfg.limits.max_rows,
      usedApprovals: new Map(),
    },
  };
}

/** The HTTP service: /healthz, and /mcp (POST only; stateless servers do not offer a GET stream or DELETE). */
export function buildMcpHttpService(opts: Parameters<typeof buildToolContext>[0] = {}): GtmMcpService {
  const { ctx, cfg } = buildToolContext(opts);
  const auth = new Authenticator(cfg, () => ctx.clock.now().getTime());
  const allowedOrigins = new Set(cfg.allowed_origins ?? []);
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return json(res, 200, { ok: true, tools: TOOLS.length, passages: ctx.playbooks.passages.length });
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    // Browsers must not be able to drive this server from another site (DNS rebinding); server-to-server calls send no Origin.
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: "origin not allowed" });
    if (req.method !== "POST") return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless" }, id: null }, { allow: "POST" });
    const a = auth.check(req.headers.authorization);
    if (!a.ok) {
      ctx.audit.append({ at: ctx.clock.now().toISOString(), actor: "mcp:unknown", action: "mcp.request", subject: "mcp", outcome: "denied", detail: { status: a.status, reason: a.reason } });
      return json(res, a.status, { error: a.reason }, a.status === 401 ? { "www-authenticate": 'Bearer realm="revops-gtm"' } : { "retry-after": "60" });
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    const authInfo: AuthInfo = { token: "redacted", clientId: a.caller.client, scopes: [...a.caller.scopes] };
    try {
      await server.connect(transport);
      await transport.handleRequest(Object.assign(req, { auth: authInfo }), res, body);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });
  return { http, ctx, auth, cfg };
}
