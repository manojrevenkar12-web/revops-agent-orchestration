/**
 * Exports labelled history for the agent service's models, from worlds the platform will never be evaluated on
 * (seeds 101-110; the live sandbox and the evaluation use seed 7 and the held-out seeds).
 *
 *   leads.jsonl     past form submissions with the intent the ADR team settled on
 *   renewals.jsonl  past renewals: the account_360 facts as the MCP server returns them, and whether the renewal
 *                   turned out at risk
 *
 * Renewal facts go through the same MCP tool code the agent uses in production, so the features the risk model is
 * trained on are computed exactly as the features it scores.
 *   npx tsx scripts/export-history.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, repoRoot } from "@revops/core";
import { buildConnectors } from "@revops/connectors";
import { buildToolContext, runTool } from "@revops/mcp-server";
import { startSandbox } from "@revops/sandbox";

const SEEDS = Array.from({ length: 10 }, (_, i) => 101 + i);
const out = join(repoRoot(), "agent", "data", "history");
mkdirSync(out, { recursive: true });
const leads: string[] = [];
const renewals: string[] = [];
const caller = { client: "export", scopes: new Set(["gtm:read", "gtm:pii"]) };

for (const seed of SEEDS) {
  const sb = await startSandbox({ seed });
  const { ctx } = buildToolContext({ connectors: buildConnectors({ baseUrl: sb.url, sleep: async () => undefined }), audit: new AuditLog(), clock: sb.clock });
  for (const f of sb.world.forms) {
    const t = sb.world.truth.forms[f.submissionId];
    leads.push(
      JSON.stringify({ seed, submissionId: f.submissionId, message: f.message, company: f.company, jobtitle: f.jobtitle, email: f.email, employees: f.employees, country: f.country, label: t }),
    );
  }
  for (const [oppId, t] of Object.entries(sb.world.truth.renewals)) {
    const opp = sb.world.opportunities.find((o) => o.Id === oppId);
    const r = await runTool("account_360", { account_id: opp?.AccountId }, ctx, caller);
    renewals.push(JSON.stringify({ seed, opportunityId: oppId, accountId: opp?.AccountId, facts: (r.data as { facts: unknown[] }).facts, atRisk: t.atRisk, drivers: t.drivers }));
  }
  await sb.close();
  process.stdout.write(`seed ${seed}: ${sb.world.forms.length} leads, ${Object.keys(sb.world.truth.renewals).length} renewals\n`);
}
writeFileSync(join(out, "leads.jsonl"), `${leads.join("\n")}\n`);
writeFileSync(join(out, "renewals.jsonl"), `${renewals.join("\n")}\n`);
process.stdout.write(`wrote ${leads.length} leads and ${renewals.length} renewals to ${out}\n`);
