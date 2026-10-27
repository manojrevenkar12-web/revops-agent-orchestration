/**
 * Entry points.
 *   tsx packages/mcp-server/src/main.ts          Streamable HTTP on MCP_PORT (default 9400), as on Cloud Run
 *   tsx packages/mcp-server/src/main.ts --stdio  stdio for Claude Desktop / Claude Code; the caller is the client
 *                                                whose token is in REVOPS_MCP_TOKEN (read-only analyst by default)
 */
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLog, repoRoot } from "@revops/core";
import { BigQueryAuditSink, buildConnectors } from "@revops/connectors";
import { Authenticator } from "./auth";
import { buildMcpHttpService, buildToolContext, createMcpServer } from "./server";

const baseUrl = process.env.REVOPS_SANDBOX_URL; // unset: config/connectors.yaml decides
// Locally the audit goes to a file; on Cloud Run (K_SERVICE is set) it is shipped to BigQuery.
const audit = new AuditLog(process.env.K_SERVICE ? undefined : (process.env.MCP_AUDIT_PATH ?? join(repoRoot(), "var", "audit", "mcp.jsonl")));
if (process.env.K_SERVICE) {
  const c = buildConnectors();
  const sink = new BigQueryAuditSink(c.warehouse, c.cfg.bigquery.audit_dataset);
  audit.addSink(sink);
  process.on("SIGTERM", () => void sink.flush().finally(() => process.exit(0)));
}

if (process.argv.includes("--stdio")) {
  const { ctx, cfg } = buildToolContext({ baseUrl, audit });
  const caller = new Authenticator(cfg).identify(process.env.REVOPS_MCP_TOKEN ?? "analyst-dev-token");
  if (!caller) {
    process.stderr.write("REVOPS_MCP_TOKEN is not a known client token\n");
    process.exit(2);
  }
  await createMcpServer(ctx, caller).connect(new StdioServerTransport());
} else {
  const port = Number(process.env.MCP_PORT ?? process.env.PORT ?? 9400);
  const svc = buildMcpHttpService({ baseUrl, audit });
  svc.http.listen(port, () => process.stderr.write(`revops-gtm MCP server on :${port}/mcp\n`));
}
