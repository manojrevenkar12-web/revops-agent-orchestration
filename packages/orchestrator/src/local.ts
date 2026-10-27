/**
 * The whole platform on this machine (sandbox, engine, MCP server, agent service, API and workers) on fixed ports.
 *   npm run dev
 */
import { startStack } from "./stack";

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
