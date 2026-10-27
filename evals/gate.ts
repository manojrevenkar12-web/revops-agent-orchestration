/**
 * Compares reports/eval/report.json with config/release.yaml and fails when a limit is missed.
 *   npx tsx evals/gate.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, repoRoot } from "@revops/core";

type G = Record<string, Record<string, number>>;
const gate = loadConfig<{ gate: G }>("release").gate;
const r = JSON.parse(readFileSync(join(repoRoot(), "reports", "eval", "report.json"), "utf8"));
const g = r.golden;
const actual: Record<string, Record<string, number | null>> = {
  leads: {
    wrong_but_auto_rate: g.leads.beforePeople.wrongButAutoRate,
    injection_reviewed: g.leads.beforePeople.injectionReviewed,
    enterprise_reviewed: g.leads.beforePeople.enterpriseReviewed,
    lead_exists_exactly_for_sales: g.leads.outcome.leadExistsExactlyForSalesRequests,
    right_queue: g.leads.outcome.salesLeadsInTheRightQueue,
    incidents: g.leads.outcome.incidents,
  },
  renewals: {
    ungrounded_proposals: g.renewals.ungroundedProposals,
    proposal_precision: g.renewals.proposalPrecision,
    proposal_recall: g.renewals.proposalRecall,
    ctas_without_approval: g.renewals.ctasWithoutApproval,
    grounded_rate: g.renewals.groundedRate,
  },
  registrations: {
    auto_approved_clean_precision: g.registrations.autoApprovedCleanPrecision,
    decision_accuracy: g.registrations.decisionAccuracy,
    leaks: g.registrations.leaks,
  },
  faults: { ungrounded_proposals: r.faults.renewals.ungroundedProposals, leaks: r.faults.registrations.leaks, incidents: r.faults.leadIncidents + r.faults.registrations.incidents },
  outage: { lost: r.outage.lost, incidents: r.outage.incidents },
};
const failures: string[] = [];
const lines: string[] = [];
for (const [area, limits] of Object.entries(gate)) {
  for (const [key, limit] of Object.entries(limits)) {
    const name = key.replace(/_(min|max)$/, "");
    const v = actual[area]?.[name];
    const ok = v !== null && v !== undefined && (key.endsWith("_min") ? v >= limit : v <= limit);
    lines.push(`${ok ? "pass" : "FAIL"}  ${area}.${name} = ${v} (${key.endsWith("_min") ? ">=" : "<="} ${limit})`);
    if (!ok) failures.push(`${area}.${name}`);
  }
}
process.stdout.write(`${lines.join("\n")}\n`);
if (failures.length) {
  process.stderr.write(`release gate failed: ${failures.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("release gate passed\n");
