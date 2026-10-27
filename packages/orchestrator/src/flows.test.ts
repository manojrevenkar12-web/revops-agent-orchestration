/**
 * The three automations end to end on the local platform: signed webhooks and Slack interactions, the BPMN and
 * DMN, the workers, the MCP server with approvals, the agent service and the sandboxed GTM systems.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConnectors, ChangeSubscriber, HttpPubSubTransport, MemoryReplayStore } from "@revops/connectors";
import { OPPORTUNITY_TOPIC, renewalSignalHandler } from "./cdc";
import { DEFAULT_KEYS, slackSignature } from "@revops/sandbox";
import { startStack, type Stack } from "./stack";

let s: Stack;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: (await r.json().catch(() => null)) as Record<string, unknown>,
  }));
const inspect = (what: string) => fetch(`${s.sb.url}/_sandbox/inspect/${what}`).then((r) => r.json() as Promise<Array<Record<string, unknown>>>);
const instances = (process: string) => [...s.engine.scopes.values()].filter((x) => x.elementType === "process" && x.bpmnProcessId === process);
const reached = (pik: string) =>
  s.engine
    .elementInstances(pik)
    .filter((e) => e.state === "COMPLETED")
    .map((e) => e.elementId);

beforeAll(async () => {
  s = await startStack();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

describe("inbound lead routing", () => {
  it("rejects a webhook whose signature does not match", async () => {
    const r = await post(`${s.sb.url}/_sandbox/hubspot/deliver`, { url: `${s.apiUrl}/webhooks/hubspot`, from: 0, count: 1, tamper: true });
    expect((r.body.delivered as Array<{ status: number }>)[0]?.status).toBe(401);
    expect(instances("inbound-lead-routing")).toHaveLength(0);
  });

  it("routes 40 submissions: confident ones on its own, the rest through an ADR in Slack", async () => {
    const r = await post(`${s.sb.url}/_sandbox/hubspot/deliver`, { url: `${s.apiUrl}/webhooks/hubspot`, from: 0, count: 40 });
    expect((r.body.delivered as Array<{ status: number }>).every((d) => d.status === 200)).toBe(true);
    // HubSpot retries deliveries: the same submissions again start nothing new.
    const again = await post(`${s.sb.url}/_sandbox/hubspot/deliver`, { url: `${s.apiUrl}/webhooks/hubspot`, from: 0, count: 5 });
    expect((again.body.delivered as Array<{ status: number }>).every((d) => d.status === 200)).toBe(true);
    await s.settle();
    expect(instances("inbound-lead-routing")).toHaveLength(40);
    const waiting = await s.approvals.list((a) => a.kind === "lead" && !a.decision);
    expect(waiting.length).toBeGreaterThan(0); // Enterprise always gets a person
    const acted = await post(`${s.sb.url}/_sandbox/people/act`, { interactionsUrl: `${s.apiUrl}/slack/interactions` });
    expect((acted.body.answered as Array<{ status: number }>).every((a) => a.status === 200)).toBe(true);
    await s.settle();
    const done = instances("inbound-lead-routing").filter((p) => p.state === "COMPLETED");
    expect(done).toHaveLength(40);
    expect([...s.engine.incidents.values()].filter((i) => i.state === "ACTIVE")).toEqual([]);

    const truth = s.sb.world.truth.forms;
    const leads = await inspect("leads");
    const salesIntents = new Set(["demo_request", "pricing", "expansion"]);
    const submitted = s.sb.world.forms.slice(0, 40);
    // Every real sales request became exactly one lead; nothing else did.
    for (const f of submitted) {
      const made = leads.filter((l) => l.HubSpot_Submission_Id__c === f.submissionId);
      expect(made.length, `${f.submissionId} ${truth[f.submissionId]?.intent}`).toBe(salesIntents.has(truth[f.submissionId]?.intent as string) ? 1 : 0);
    }
    const tasks = await inspect("tasks");
    expect(tasks.filter((t) => String(t.External_Key__c).startsWith("lead-followup-")).length).toBe(leads.length);
    for (const t of tasks.filter((x) => String(x.External_Key__c).startsWith("lead-followup-"))) expect(String(t.WhoId)).toMatch(/^00Q/);

    // Writes carried approvals: from the policy, or from the ADR who clicked.
    const issued = s.audit.list((e) => e.action === "approval.issued", 1000);
    expect(issued.some((e) => e.detail.approvedBy === "policy:inbound-lead-routing")).toBe(true);
    expect(issued.some((e) => String(e.detail.approvedBy).startsWith("slack:"))).toBe(true);
    const writes = s.audit.list((e) => e.action === "tool.call" && e.subject === "tool/crm_upsert_lead", 1000);
    expect(writes.every((e) => e.outcome === "ok" && e.detail.approvedBy)).toBe(true);
    expect(s.audit.verify().intact).toBe(true);
  }, 120_000);

  it("escalates after the speed-to-lead target and sends unanswered leads to the review queue", async () => {
    const enterprise = s.sb.world.forms.slice(40).find((f) => f.employees === "5000+" && ["demo_request", "pricing"].includes(s.sb.world.truth.forms[f.submissionId]?.intent as string));
    expect(enterprise).toBeTruthy();
    await post(`${s.sb.url}/_sandbox/hubspot/deliver`, { url: `${s.apiUrl}/webhooks/hubspot`, ids: [enterprise?.submissionId] });
    await s.settle();
    const pi = instances("inbound-lead-routing").find((p) => (p.vars.submission as { submissionId: string }).submissionId === enterprise?.submissionId);
    expect(pi?.state).toBe("ACTIVE");
    await s.advance(16 * 60_000);
    await s.settle();
    const slack = await inspect("slack");
    expect(slack.some((m) => m.channel === "#adr-managers" && String(m.text).includes("Speed-to-lead"))).toBe(true);
    await s.advance(4 * 3_600_000);
    await s.settle();
    expect(pi?.state).toBe("COMPLETED");
    const lead = (await inspect("leads")).find((l) => l.HubSpot_Submission_Id__c === enterprise?.submissionId);
    expect(lead?.Routing_Queue__c).toBe("Lead Review");
    const issued = s.audit.list((e) => e.action === "approval.issued" && e.subject === `process/${pi?.key}`, 10);
    expect(issued[0]?.detail.approvedBy).toBe("policy:review-timeout");
  }, 60_000);
});

describe("renewal risk save play", () => {
  it("investigates renewals, proposes save plays only for grounded at-risk briefs, and writes after the CSM approves", async () => {
    const scan = await post(`${s.apiUrl}/jobs/renewal-scan`, {}, { authorization: "Bearer dev-scheduler-token" });
    expect(scan.status).toBe(200);
    await s.settle(120_000);
    const pis = instances("renewal-risk-save-play");
    expect(pis.length).toBe(Number(scan.body.published));
    const asked = await s.approvals.list((a) => a.kind === "renewal");
    expect(asked.length).toBeGreaterThan(0);
    // Every proposal rests on a brief that passed the claim check.
    for (const a of asked) {
      const pi = pis.find((p) => p.key === a.processInstanceKey);
      expect((pi?.vars.verification as { grounded: boolean }).grounded).toBe(true);
    }
    await post(`${s.sb.url}/_sandbox/people/act`, { interactionsUrl: `${s.apiUrl}/slack/interactions` });
    await s.settle(60_000);
    const ctas = (await inspect("ctas")) as Array<{ referenceId: string }>;
    const approved = await s.approvals.list((a) => a.kind === "renewal" && a.decision?.outcome === "approve");
    expect(ctas.filter((c) => c.referenceId.startsWith("renewal-risk-")).length).toBe(approved.length);
    const truth = s.sb.world.truth.renewals;
    // Compared with the truth the platform never sees: proposals are mostly real risks.
    const precision = asked.filter((a) => truth[a.subjectId]?.atRisk).length / asked.length;
    expect(precision).toBeGreaterThan(0.8);
  }, 180_000);
});

describe("Slack interactions", () => {
  it("tells a person when the request they click was already decided, and refuses unsigned clicks", async () => {
    const decided = (await s.approvals.list((a) => !!a.decision))[0];
    expect(decided).toBeTruthy();
    const payload = { type: "block_actions", user: { id: "U0LATE" }, actions: [{ action_id: "approve", value: JSON.stringify({ approvalId: decided?.approvalId }) }] };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const ts = String(Math.floor(s.clock.now().getTime() / 1000));
    const send = (sig: string) =>
      fetch(`${s.apiUrl}/slack/interactions`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
        body,
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as { text?: string } }));
    const late = await send(slackSignature(DEFAULT_KEYS.slackSigningSecret, ts, body));
    expect(late.status).toBe(200);
    expect(late.body.text).toMatch(/no longer open/);
    expect((await send("v0=forged")).status).toBe(401);
  });
});

describe("renewal signals from change data capture", () => {
  it("starts an investigation when a rep pushes a renewal's close date, and not for other changes", async () => {
    const sf = buildConnectors({ baseUrl: s.sb.url, sleep: async () => undefined }).salesforce;
    const sub = new ChangeSubscriber(new HttpPubSubTransport(sf), new MemoryReplayStore(), sf, { [OPPORTUNITY_TOPIC]: { object: "Opportunity", fields: ["Id", "CloseDate"] } });
    const handle = renewalSignalHandler({ camunda: s.client, mcp: s.mcp, audit: s.audit, clock: s.clock });
    await sub.poll(OPPORTUNITY_TOPIC, handle); // takes the current position
    const done = instances("renewal-risk-save-play").filter((p) => p.state === "COMPLETED");
    const opp = String(done[0]?.vars.opportunityId);
    const before = instances("renewal-risk-save-play").length;
    await post(`${s.sb.url}/_sandbox/scenario/push-close-date`, { opportunityId: opp, days: 30 });
    const r = await sub.poll(OPPORTUNITY_TOPIC, handle);
    expect(r.delivered).toBeGreaterThan(0);
    await s.settle(60_000);
    const after = instances("renewal-risk-save-play");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.vars.trigger).toBe("close_date_moved");
  }, 90_000);
});

describe("partner deal registration", () => {
  it("approves clean registrations by policy and sends conflicts to the deal desk without leaking them to the partner", async () => {
    const poll = await post(`${s.apiUrl}/jobs/registration-poll`, {}, { authorization: "Bearer dev-scheduler-token" });
    expect(Number(poll.body.started)).toBeGreaterThan(10);
    const again = await post(`${s.apiUrl}/jobs/registration-poll`, {}, { authorization: "Bearer dev-scheduler-token" });
    expect(again.body.started).toBe(0);
    await s.settle(120_000);
    await post(`${s.sb.url}/_sandbox/people/act`, { interactionsUrl: `${s.apiUrl}/slack/interactions` });
    await s.settle(60_000);
    const decisions = (await inspect("decisions")) as Array<{ id: string; status: string; reason: string }>;
    const truth = s.sb.world.truth.registrations;
    expect(decisions.length).toBeGreaterThan(0);
    for (const dcs of decisions) {
      const t = truth[dcs.id];
      if (t?.conflict === "none") expect(dcs.status).toBe("Approved");
    }
    const autos = s.audit.list((e) => e.action === "approval.issued" && e.detail.approvedBy === "policy:partner-deal-registration", 1000);
    expect(autos.length).toBeGreaterThan(0);
    for (const dcs of decisions) expect(dcs.reason).not.toMatch(/Renewal|Expansion|New Business/);
  }, 180_000);
});

describe("the console API", () => {
  it("reports what the automations did", async () => {
    const o = (await fetch(`${s.apiUrl}/api/overview`).then((r) => r.json())) as {
      leads: { received: number; autoRouted: number };
      hoursSaved: number;
      processes: Array<{ id: string; completed: number }>;
    };
    expect(o.leads.received).toBeGreaterThanOrEqual(41);
    expect(o.leads.autoRouted).toBeGreaterThan(0);
    expect(o.hoursSaved).toBeGreaterThan(0);
    expect(o.processes.find((p) => p.id === "inbound-lead-routing")?.completed).toBeGreaterThanOrEqual(41);
    const list = (await fetch(`${s.apiUrl}/api/instances?process=renewal-risk-save-play`).then((r) => r.json())) as { items: Array<{ processInstanceKey: string }> };
    const detail = (await fetch(`${s.apiUrl}/api/instances/${list.items[0]?.processInstanceKey}`).then((r) => r.json())) as { xml: string; elements: unknown[]; audit: unknown[] };
    expect(detail.xml).toContain("bpmndi:BPMNDiagram");
    expect(detail.elements.length).toBeGreaterThan(3);
    const tools = (await fetch(`${s.apiUrl}/api/tools`).then((r) => r.json())) as { tools: Array<{ name: string }> };
    expect(tools.tools.map((t) => t.name)).toContain("crm_upsert_lead");
  });
});
