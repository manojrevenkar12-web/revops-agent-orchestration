/**
 * Camunda's own 8.8 TypeScript client (@camunda8/orchestration-cluster-api, generated from the Orchestration Cluster
 * OpenAPI spec) talking to the local engine with request AND response validation on. If the local REST API drifted
 * from Camunda's schema, these calls would fail validation. The workers use the same client in production.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CamundaClient, createCamundaClient } from "@camunda8/orchestration-cluster-api";
import { ManualClock, repoRoot } from "@revops/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEngineServer } from "./server";

let srv: Awaited<ReturnType<typeof buildEngineServer>>;
let client: CamundaClient;
const clock = new ManualClock("2026-10-26T09:00:00Z");
const now = { consistency: { waitUpToMs: 0 } };

beforeAll(async () => {
  srv = await buildEngineServer({ clock, deploy: false });
  await srv.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = srv.app.server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v2`;
  client = createCamundaClient({ config: { CAMUNDA_REST_ADDRESS: url, CAMUNDA_AUTH_STRATEGY: "NONE", CAMUNDA_SDK_VALIDATION: "req:none,res:strict", CAMUNDA_SDK_LOG_LEVEL: "silent" } as never });
});
afterAll(async () => {
  await srv.app.close();
});

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const file = (name: string) => new File([readFileSync(join(repoRoot(), "processes", name))], name, { type: "application/xml" });
const activate = async (type: string) => (await client.activateJobs({ type, worker: "test", timeout: 60_000, maxJobsToActivate: 5, requestTimeout: -1 } as never)).jobs;

describe("Camunda 8.8 Orchestration Cluster client against the local engine", () => {
  it("deploys the RevOps processes and decisions", async () => {
    const d = await client.createDeployment({
      resources: ["inbound-lead-routing.bpmn", "renewal-risk-save-play.bpmn", "partner-deal-registration.bpmn", "lead-routing.dmn", "deal-registration-policy.dmn"].map(file),
    } as never);
    const kinds = (d.deployments as Array<Record<string, unknown>>).map((x) => Object.keys(x)[0]);
    expect(kinds.filter((k) => k === "processDefinition")).toHaveLength(3);
    expect(kinds.filter((k) => k === "decisionDefinition")).toHaveLength(2);
    const topo = await client.getTopology();
    expect(topo.gatewayVersion).toMatch(/^8\.8/);
  });

  it("runs a deal registration end to end with job workers, the DMN policy and an automatic approval", async () => {
    const seen: string[] = [];
    const reply = (type: string, vars: (v: Record<string, unknown>) => Record<string, unknown>) =>
      client.createJobWorker({
        jobType: type,
        jobTimeoutMs: 30_000,
        maxParallelJobs: 5,
        pollIntervalMs: 10,
        pollTimeoutMs: 200,
        jobHandler: (job) => {
          seen.push(job.elementId);
          return job.complete(vars(job.variables as Record<string, unknown>));
        },
      });
    const workers = [
      reply("dealreg.conflicts", () => ({ registration: { id: "DR-1", amount: 20_000 }, conflict: { kind: "none", lateStage: false } })),
      reply("agent.dealreg.draft", () => ({
        plan: { writes: { approve: { tool: "prm_decide_registration", args: { registration_id: "DR-1", decision: "Approved", reason: "No conflict." } }, reject: null } },
      })),
      reply("approval.issue", (v) => ({ approvals: { decide: v.approvedBy === "policy:partner-deal-registration" ? "token" : "wrong" } })),
      reply("mcp.call", (v) => ({ toolResult: { ok: v.approval === "token", decision: (v.args as { decision: string }).decision } })),
      reply("slack.notify", () => ({})),
    ];
    await client.publishMessage({
      name: "impartner.registration.submitted",
      correlationKey: "DR-1",
      variables: { registrationId: "DR-1", policy: { mode: "auto", autoApproveMaxAmount: 50_000, decisionDeadline: "P2D" } },
      timeToLive: 0,
    } as never);
    await waitFor(() => seen.includes("NotifyPartnerManager"));
    for (const w of workers) await w.stopGracefully({ timeoutMs: 2000 } as never);
    const done = await client.searchProcessInstances({ filter: { processDefinitionId: "partner-deal-registration", state: "COMPLETED" } } as never, now as never);
    expect(done.items).toHaveLength(1);
    expect(seen).toEqual(["CheckConflicts", "DraftMessage", "IssueDealApproval", "DecideInImpartner", "NotifyPartnerManager"]);
    const vars = srv.engine.scopes.get(String(done.items[0]?.processInstanceKey))?.vars;
    expect(vars?.decisionResult).toEqual({ ok: true, decision: "Approved" });
  });

  it("drives the agent loop with ad-hoc job results and waits for a person on a controlled clock", async () => {
    await expect(client.createProcessInstance({ processDefinitionId: "renewal-risk-save-play", variables: {} } as never)).rejects.toThrow();
    await client.publishMessage({
      name: "renewal.signal",
      correlationKey: "006X",
      variables: { opportunityId: "006X", accountId: "001X", policy: { agentTimeBudget: "PT10M", createCtaMinProbability: 0.8, approvalDeadline: "PT24H" } },
      timeToLive: 0,
    } as never);
    const [pi] = (await client.searchProcessInstances({ filter: { processDefinitionId: "renewal-risk-save-play", state: "ACTIVE" } } as never, now as never)).items;
    const [agentJob] = await activate("agent.renewal.investigate");
    const tools = (agentJob?.variables as { adHocSubProcessElements: Array<{ elementId: string }> }).adHocSubProcessElements.map((t) => t.elementId);
    expect(tools).toEqual(["Account360", "SearchPlaybooks", "OpenOpportunities"]);
    await client.completeJob({
      jobKey: agentJob?.jobKey,
      variables: { agent: { turn: 1 } },
      result: {
        type: "adHocSubProcess",
        activateElements: [{ elementId: "Account360", variables: { toolCall: { _meta: { id: "t1", name: "Account360" }, accountId: "001X" } } }],
        isCompletionConditionFulfilled: false,
        isCancelRemainingInstances: false,
      },
    } as never);
    const [toolJob] = await activate("mcp.call");
    expect(toolJob?.customHeaders).toMatchObject({ tool: "account_360" });
    expect(toolJob?.variables).toMatchObject({ args: { account_id: "001X" } });
    await client.completeJob({ jobKey: toolJob?.jobKey, variables: { toolResult: { facts: [{ id: "usage.process_instances_change_pct", value: -42 }] } } } as never);
    const [again] = await activate("agent.renewal.investigate");
    expect((again?.variables as { toolCallResults: Array<{ id: string }> }).toolCallResults[0]?.id).toBe("t1");
    await client.completeJob({
      jobKey: again?.jobKey,
      variables: { agent: { brief: { atRisk: true, claims: [] }, stats: { modelCalls: 2 } } },
      result: { type: "adHocSubProcess", activateElements: [], isCompletionConditionFulfilled: true, isCancelRemainingInstances: false },
    } as never);
    const [verify] = await activate("agent.brief.verify");
    expect(verify?.variables).toMatchObject({ brief: { atRisk: true }, agentStats: { modelCalls: 2 } });
    await client.completeJob({ jobKey: verify?.jobKey, variables: { verification: { grounded: true, riskProbability: 0.93 } } } as never);
    const [plan] = await activate("renewal.plan");
    await client.completeJob({ jobKey: plan?.jobKey, variables: { plan: { writes: {} } } } as never);
    const [ask] = await activate("slack.approval.request");
    await client.completeJob({ jobKey: ask?.jobKey, variables: { approvalId: "apv-renewal-1" } } as never);

    // Nobody answers for 24 hours: the pinned clock moves and the escalation runs.
    await client.pinClock({ timestamp: clock.now().getTime() + 24 * 3_600_000 + 1000 } as never);
    const [escalate] = await activate("slack.notify");
    expect(escalate?.elementId).toBe("EscalateToCsLead");
    await client.completeJob({ jobKey: escalate?.jobKey, variables: {} } as never);
    const corr = await client.correlateMessage({ name: "approval.decided", correlationKey: "apv-renewal-1", variables: { decision: { outcome: "reject", by: "U0CSLEAD" } } } as never);
    expect(String(corr.processInstanceKey)).toBe(String(pi?.processInstanceKey));
    const [close] = await activate("slack.approval.close");
    expect(close?.customHeaders).toMatchObject({ outcome: "declined" });
    await client.completeJob({ jobKey: close?.jobKey, variables: {} } as never);
    const els = await client.searchElementInstances({ filter: { processInstanceKey: pi?.processInstanceKey } } as never, now as never);
    expect((els.items ?? []).map((e) => e.elementId)).toContain("CsmDeclined");
  });

  it("surfaces an incident and resolves it after the retries are updated", async () => {
    await client.publishMessage({ name: "impartner.registration.submitted", correlationKey: "DR-2", variables: { registrationId: "DR-2", policy: {} }, timeToLive: 0 } as never);
    const [job] = await activate("dealreg.conflicts");
    await client.failJob({ jobKey: job?.jobKey, retries: 0, errorMessage: "Impartner returned 500" } as never);
    const inc = await client.searchIncidents({ filter: { state: "ACTIVE" } } as never, now as never);
    const mine = (inc.items ?? []).find((i) => String(i.jobKey) === String(job?.jobKey));
    expect(mine?.errorType).toBe("JOB_NO_RETRIES");
    await client.updateJob({ jobKey: job?.jobKey, changeset: { retries: 1 } } as never);
    await client.resolveIncident({ incidentKey: mine?.incidentKey } as never);
    const [retry] = await activate("dealreg.conflicts");
    expect(String(retry?.jobKey)).toBe(String(job?.jobKey));
  });
});
