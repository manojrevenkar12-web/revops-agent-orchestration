/**
 * The platform with a morning's worth of activity, for the console's end-to-end tests and for a look around:
 * 80 form submissions, the weekly renewal scan and the registration poll, with people answering about half of the
 * open requests in Slack.
 *   npx tsx scripts/demo.ts [--port 9601]
 */
import { startStack } from "@revops/orchestrator";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 9601);
const s = await startStack({ ports: { api: port } });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const auth = { authorization: "Bearer dev-scheduler-token" };
await post(`${s.sb.url}/_sandbox/hubspot/deliver`, { url: `${s.apiUrl}/webhooks/hubspot`, from: 0, count: 80 });
await post(`${s.apiUrl}/jobs/renewal-scan`, {}, auth);
await post(`${s.apiUrl}/jobs/registration-poll`, {}, auth);
await s.settle(120_000);
await post(`${s.sb.url}/_sandbox/people/act`, { interactionsUrl: `${s.apiUrl}/slack/interactions`, limit: 20 });
await s.settle(120_000);
process.stdout.write(`demo ready on ${s.apiUrl}\n`);
