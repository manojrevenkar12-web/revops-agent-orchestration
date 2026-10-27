/**
 * Entry points.
 *
 *   tsx packages/orchestrator/src/main.ts --local     the whole platform on this machine (sandbox, engine, MCP
 *                                                     server, agent service, API, workers) with fixed ports
 *   tsx packages/orchestrator/src/main.ts             the orchestrator alone (Cloud Run): API and workers against
 *                                                     Camunda 8.8, the MCP server and the agent service from env
 */
import { join } from "node:path";
import { AuditLog, loadConfig, repoRoot, systemClock } from "@revops/core";
import { BigQueryAuditSink, buildConnectors, ChangeSubscriber, FileReplayStore, HttpPubSubTransport } from "@revops/connectors";
import { buildApi } from "./api";

import { renewalSignalHandler, startCdc } from "./cdc";
import { AgentClient, camunda, McpGateway } from "./clients";
import { Approvals } from "./approvals";
import { startStack } from "./stack";
import { startWorkers } from "./workers";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`${k} is not set`);
  return v;
};

if (process.argv.includes("--local")) {
  const s = await startStack({ ports: { sandbox: 9300, engine: 8088, mcp: 9400, agent: 9500, api: 9600 }, quiet: false });
  process.stdout.write(
    [
      "RevOps platform running locally",
      `  console and API   ${s.apiUrl}`,
      `  Camunda REST v2   ${s.engineUrl}/v2`,
      `  GTM MCP server    ${s.mcpUrl}   (token: analyst-dev-token or orchestrator-dev-token)`,
      `  agent service     ${s.agentUrl}`,
      `  GTM sandbox       ${s.sb.url}`,
      'Try: curl -XPOST localhost:9300/_sandbox/hubspot/deliver -H \'content-type: application/json\' -d \'{"url":"http://127.0.0.1:9600/webhooks/hubspot","count":20}\'',
      "",
    ].join("\n"),
  );
} else {
  const connectors = buildConnectors();
  const audit = new AuditLog();
  const sink = new BigQueryAuditSink(connectors.warehouse, connectors.cfg.bigquery.audit_dataset);
  audit.addSink(sink);
  process.on("SIGTERM", () => void sink.flush().finally(() => process.exit(0)));
  const client = camunda(env("CAMUNDA_REST_ADDRESS"));
  const mcp = new McpGateway(env("MCP_URL"), env("MCP_TOKEN"));
  const approvals = new Approvals(client);
  const mcpCfg = loadConfig<{ approvals: { secret: string } }>("mcp");
  const api = buildApi({
    camunda: client,
    mcp,
    slack: connectors.slack,
    approvals,
    audit,
    clock: systemClock,
    hubspotSecret: connectors.cfg.hubspot.client_secret,
    slackSigningSecret: connectors.cfg.slack.signing_secret,
    schedulerToken: process.env.SCHEDULER_TOKEN,
    schedulerServiceAccount: process.env.SCHEDULER_SERVICE_ACCOUNT,
    publicBaseUrl: () => env("PUBLIC_BASE_URL"),
    consoleDir: join(repoRoot(), "apps", "console", "dist"),
  });
  startWorkers(client, {
    mcp,
    agent: new AgentClient(env("AGENT_URL"), env("AGENT_SERVICE_TOKEN")),
    slack: connectors.slack,
    channels: connectors.cfg.slack.channels,
    teams: (connectors.cfg.slack as unknown as { teams: Record<string, string> }).teams ?? {},
    audit,
    approvalSecret: mcpCfg.approvals.secret,
    clock: systemClock,
  });
  if (process.env.CDC_ENABLED === "true") {
    const sub = new ChangeSubscriber(new HttpPubSubTransport(connectors.salesforce), new FileReplayStore(join(repoRoot(), "var", "replay.json")), connectors.salesforce, {
      "/data/OpportunityChangeEvent": { object: "Opportunity", fields: ["Id", "CloseDate", "Type"] },
    });
    startCdc(sub, renewalSignalHandler({ camunda: client, mcp, audit, clock: systemClock }));
  }
  await api.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
}
