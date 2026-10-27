import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManualClock, repoRoot } from "@revops/core";
import { describe, expect, it } from "vitest";
import { Engine, EngineError, type Vars } from "./engine";
import { processResources } from "./server";

const NS = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
const bpmn = (id: string, body: string, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions ${NS} id="D_${id}" targetNamespace="t"><bpmn:process id="${id}" isExecutable="true">${body}</bpmn:process>${extra}</bpmn:definitions>`;
const task = (id: string, type: string, inner = "", ext = "") =>
  `<bpmn:serviceTask id="${id}" name="${id}"><bpmn:extensionElements><zeebe:taskDefinition type="${type}" retries="2" />${ext}</bpmn:extensionElements>${inner}</bpmn:serviceTask>`;
const flow = (id: string, a: string, b: string, cond?: string) =>
  `<bpmn:sequenceFlow id="${id}" sourceRef="${a}" targetRef="${b}">${cond ? `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${cond}</bpmn:conditionExpression>` : ""}</bpmn:sequenceFlow>`;

async function engineWith(...xml: string[]) {
  const clock = new ManualClock("2026-10-26T09:00:00Z");
  const e = new Engine(clock);
  await e.deploy(xml.map((content, i) => ({ name: `p${i}.bpmn`, content })));
  return { e, clock };
}

/** Run one job of a type like a worker would. */
function work(e: Engine, type: string, fn: (vars: Vars, headers: Record<string, string>) => Vars | { error: string } | { fail: string } = () => ({})) {
  const [job] = e.activateJobs({ type, worker: "test", maxJobsToActivate: 1, timeout: 60_000 });
  if (!job) throw new Error(`no ${type} job`);
  const r = fn(job.variables, job.customHeaders);
  if ("error" in r) e.throwError(job.key, { errorCode: String(r.error) });
  else if ("fail" in r) e.failJob(job.key, { retries: job.retries - 1, errorMessage: String(r.fail) });
  else e.completeJob(job.key, r);
  return job;
}

describe("variables and mappings", () => {
  it("propagates job variables to the process, keeps input mappings local, applies output mappings", async () => {
    const xml = bpmn(
      "vars",
      `<bpmn:startEvent id="s" />${task("a", "a", "", `<zeebe:ioMapping><zeebe:input source="=order.amount * 2" target="double" /><zeebe:output source="=result + 1" target="answer" /></zeebe:ioMapping>`)}${task("b", "b")}<bpmn:endEvent id="end" />${flow("f1", "s", "a")}${flow("f2", "a", "b")}${flow("f3", "b", "end")}`,
    );
    const { e } = await engineWith(xml);
    const pi = e.createProcessInstance({ bpmnProcessId: "vars", variables: { order: { amount: 21 } } });
    work(e, "a", (v) => {
      expect(v.double).toBe(42);
      return { result: 41, scratch: "dropped by the output mapping" };
    });
    work(e, "b", (v) => {
      expect(v.answer).toBe(42);
      expect(v.double).toBeUndefined();
      expect(v.scratch).toBeUndefined();
      return { done: true };
    });
    expect(pi.state).toBe("COMPLETED");
    expect(pi.vars).toMatchObject({ answer: 42, done: true, order: { amount: 21 } });
  });
});

describe("jobs", () => {
  const xml = bpmn(
    "jobs",
    `<bpmn:startEvent id="s" />${task("work", "work")}<bpmn:boundaryEvent id="caught" attachedToRef="work"><bpmn:errorEventDefinition errorRef="Err" /></bpmn:boundaryEvent><bpmn:endEvent id="ok" /><bpmn:endEvent id="handled" />${flow("f1", "s", "work")}${flow("f2", "work", "ok")}${flow("f3", "caught", "handled")}`,
    `<bpmn:error id="Err" errorCode="NOT_ALLOWED" />`,
  );

  it("times out an activated job so another worker can take it", async () => {
    const { e, clock } = await engineWith(xml);
    e.createProcessInstance({ bpmnProcessId: "jobs" });
    expect(e.activateJobs({ type: "work", worker: "w1", maxJobsToActivate: 5, timeout: 1000 })).toHaveLength(1);
    expect(e.activateJobs({ type: "work", worker: "w2", maxJobsToActivate: 5, timeout: 1000 })).toHaveLength(0);
    clock.advance(1001);
    expect(e.activateJobs({ type: "work", worker: "w2", maxJobsToActivate: 5, timeout: 1000 })[0]?.worker).toBe("w2");
  });

  it("retries with back-off, raises an incident at zero retries, and resumes after the incident is resolved", async () => {
    const { e, clock } = await engineWith(xml);
    const pi = e.createProcessInstance({ bpmnProcessId: "jobs" });
    const [j] = e.activateJobs({ type: "work", worker: "w", maxJobsToActivate: 1, timeout: 1000 });
    e.failJob(j?.key as string, { retries: 1, errorMessage: "503 from Salesforce", retryBackOff: 30_000 });
    expect(e.activateJobs({ type: "work", worker: "w", maxJobsToActivate: 1, timeout: 1000 })).toHaveLength(0);
    clock.advance(30_000);
    const [again] = e.activateJobs({ type: "work", worker: "w", maxJobsToActivate: 1, timeout: 1000 });
    e.failJob(again?.key as string, { retries: 0, errorMessage: "still failing" });
    const inc = [...e.incidents.values()].find((i) => i.processInstanceKey === pi.key);
    expect(inc).toMatchObject({ errorType: "JOB_NO_RETRIES", state: "ACTIVE", errorMessage: "still failing" });
    expect(() => e.resolveIncident(inc?.key as string)).toThrow(EngineError); // retries first
    e.updateJob(again?.key as string, { retries: 1 });
    e.resolveIncident(inc?.key as string);
    work(e, "work");
    expect(pi.state).toBe("COMPLETED");
  });

  it("routes a business error to the matching boundary event, and an unknown one to an incident", async () => {
    const { e } = await engineWith(xml);
    const a = e.createProcessInstance({ bpmnProcessId: "jobs" });
    work(e, "work", () => ({ error: "NOT_ALLOWED" }));
    expect(a.state).toBe("COMPLETED");
    expect(e.elementInstances(a.key).map((s) => s.elementId)).toContain("handled");
    const b = e.createProcessInstance({ bpmnProcessId: "jobs" });
    work(e, "work", () => ({ error: "SOMETHING_ELSE" }));
    expect(b.state).toBe("ACTIVE");
    expect([...e.incidents.values()].find((i) => i.processInstanceKey === b.key)?.errorType).toBe("UNHANDLED_ERROR_EVENT");
  });
});

describe("gateways", () => {
  it("takes the first true condition, else the default, and raises an incident when nothing applies", async () => {
    const xml = (withDefault: boolean) =>
      bpmn(
        `gw${withDefault ? 1 : 0}`,
        `<bpmn:startEvent id="s" /><bpmn:exclusiveGateway id="g" ${withDefault ? 'default="fd"' : ""} /><bpmn:endEvent id="big" /><bpmn:endEvent id="small" />${flow("f1", "s", "g")}${flow("fb", "g", "big", "=amount &gt; 100")}${withDefault ? flow("fd", "g", "small") : flow("fs", "g", "small", "=amount &lt; 10")}`,
      );
    const { e } = await engineWith(xml(true), xml(false));
    const big = e.createProcessInstance({ bpmnProcessId: "gw1", variables: { amount: 500 } });
    const dflt = e.createProcessInstance({ bpmnProcessId: "gw1", variables: { amount: 50 } });
    expect(e.elementInstances(big.key).some((s) => s.elementId === "big")).toBe(true);
    expect(e.elementInstances(dflt.key).some((s) => s.elementId === "small")).toBe(true);
    const stuck = e.createProcessInstance({ bpmnProcessId: "gw0", variables: { amount: 50 } });
    expect([...e.incidents.values()].find((i) => i.processInstanceKey === stuck.key)?.errorType).toBe("CONDITION_ERROR");
  });

  it("joins parallel branches before continuing", async () => {
    const xml = bpmn(
      "par",
      `<bpmn:startEvent id="s" /><bpmn:parallelGateway id="fork" />${task("a", "a")}${task("b", "b")}<bpmn:parallelGateway id="join" />${task("after", "after")}<bpmn:endEvent id="end" />${flow("f1", "s", "fork")}${flow("f2", "fork", "a")}${flow("f3", "fork", "b")}${flow("f4", "a", "join")}${flow("f5", "b", "join")}${flow("f6", "join", "after")}${flow("f7", "after", "end")}`,
    );
    const { e } = await engineWith(xml);
    const pi = e.createProcessInstance({ bpmnProcessId: "par" });
    work(e, "a");
    expect(e.activateJobs({ type: "after", worker: "w", maxJobsToActivate: 1, timeout: 1 })).toHaveLength(0);
    work(e, "b");
    work(e, "after");
    expect(pi.state).toBe("COMPLETED");
  });
});

describe("messages and timers", () => {
  const xml = bpmn(
    "wait",
    `<bpmn:startEvent id="s" /><bpmn:receiveTask id="r" messageRef="M" /><bpmn:boundaryEvent id="remind" cancelActivity="false" attachedToRef="r"><bpmn:timerEventDefinition><bpmn:timeCycle>R2/PT1H</bpmn:timeCycle></bpmn:timerEventDefinition></bpmn:boundaryEvent><bpmn:boundaryEvent id="late" attachedToRef="r"><bpmn:timerEventDefinition><bpmn:timeDuration>=deadline</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>${task("reminder", "reminder")}<bpmn:endEvent id="reminded" /><bpmn:endEvent id="answered" /><bpmn:endEvent id="expired" />${flow("f1", "s", "r")}${flow("f2", "r", "answered")}${flow("f3", "remind", "reminder")}${flow("f4", "reminder", "reminded")}${flow("f5", "late", "expired")}`,
    `<bpmn:message id="M" name="decided"><bpmn:extensionElements><zeebe:subscription correlationKey="=approvalId" /></bpmn:extensionElements></bpmn:message>`,
  );

  it("correlates by key, buffers with a time to live, refuses a duplicate message id, and correlates once per instance", async () => {
    const { e, clock } = await engineWith(xml);
    const early = e.publishMessage({ name: "decided", correlationKey: "apv-2", variables: { decision: "yes" }, timeToLive: 60_000, messageId: "slack-123" });
    expect(early.correlatedTo).toHaveLength(0);
    expect(() => e.publishMessage({ name: "decided", correlationKey: "apv-2", timeToLive: 60_000, messageId: "slack-123" })).toThrow(/already published/);
    const a = e.createProcessInstance({ bpmnProcessId: "wait", variables: { approvalId: "apv-1", deadline: "PT4H" } });
    const b = e.createProcessInstance({ bpmnProcessId: "wait", variables: { approvalId: "apv-2", deadline: "PT4H" } });
    expect(b.state).toBe("COMPLETED"); // the buffered message was waiting for it
    expect(b.vars.decision).toBe("yes");
    expect(a.state).toBe("ACTIVE");
    e.publishMessage({ name: "decided", correlationKey: "apv-1", variables: { decision: "no" } });
    expect(a.state).toBe("COMPLETED");
    expect(a.vars.decision).toBe("no");
    clock.advance(61_000);
    expect(() => e.publishMessage({ name: "decided", correlationKey: "x", timeToLive: 1000, messageId: "slack-123" })).not.toThrow(); // expired, id free again
  });

  it("fires non-interrupting reminders on a cycle and the interrupting deadline once", async () => {
    const { e, clock } = await engineWith(xml);
    const pi = e.createProcessInstance({ bpmnProcessId: "wait", variables: { approvalId: "apv-9", deadline: "PT3H30M" } });
    clock.advance(3_600_000);
    e.tick();
    work(e, "reminder");
    clock.advance(3_600_000);
    e.tick();
    work(e, "reminder");
    clock.advance(3_600_000);
    e.tick();
    expect(e.activateJobs({ type: "reminder", worker: "w", maxJobsToActivate: 5, timeout: 1 })).toHaveLength(0); // R2: only two
    expect(pi.state).toBe("ACTIVE");
    clock.advance(1_800_000);
    e.tick();
    expect(pi.state).toBe("COMPLETED");
    expect(e.elementInstances(pi.key).find((s) => s.elementId === "r")?.state).toBe("TERMINATED");
    expect(() => e.correlateMessage({ name: "decided", correlationKey: "apv-9" })).toThrow(/no process instance is waiting/);
  });

  it("starts one instance per correlation key from a message start event", async () => {
    const xml2 = bpmn(
      "ms",
      `<bpmn:startEvent id="s"><bpmn:messageEventDefinition messageRef="S" /></bpmn:startEvent>${task("t", "t")}<bpmn:endEvent id="e" />${flow("f1", "s", "t")}${flow("f2", "t", "e")}`,
      `<bpmn:message id="S" name="signal" />`,
    );
    const { e } = await engineWith(xml2);
    e.publishMessage({ name: "signal", correlationKey: "opp-1", variables: { opportunityId: "opp-1" } });
    e.publishMessage({ name: "signal", correlationKey: "opp-1" });
    e.publishMessage({ name: "signal", correlationKey: "opp-2" });
    expect([...e.scopes.values()].filter((s) => s.elementType === "process")).toHaveLength(2);
    work(e, "t");
    e.publishMessage({ name: "signal", correlationKey: "opp-1" });
    expect([...e.scopes.values()].filter((s) => s.elementType === "process")).toHaveLength(3);
  });
});

describe("ad-hoc sub-process with a job worker (the agent pattern)", () => {
  const xml = bpmn(
    "agentic",
    `<bpmn:startEvent id="s" /><bpmn:adHocSubProcess id="agent"><bpmn:extensionElements><zeebe:taskDefinition type="agent" retries="2" /><zeebe:adHoc outputCollection="toolCallResults" outputElement="={id: toolCall._meta.id, content: toolCallResult}" /><zeebe:ioMapping><zeebe:output source="=answer" target="answer" /><zeebe:output source="=toolCallResults" target="evidence" /></zeebe:ioMapping></bpmn:extensionElements>
      ${task("lookup", "lookup", "<bpmn:documentation>Look something up</bpmn:documentation>", `<zeebe:ioMapping><zeebe:input source="={q: fromAi(toolCall.query, &quot;what to look up&quot;, &quot;string&quot;)}" target="args" /><zeebe:output source="=found" target="toolCallResult" /></zeebe:ioMapping>`)}
    </bpmn:adHocSubProcess><bpmn:endEvent id="e" />${flow("f1", "s", "agent")}${flow("f2", "agent", "e")}`,
  );

  it("describes its tools, runs the chosen ones with local variables, and loops until the worker says done", async () => {
    const { e } = await engineWith(xml);
    const pi = e.createProcessInstance({ bpmnProcessId: "agentic" });
    const [first] = e.activateJobs({ type: "agent", worker: "w", maxJobsToActivate: 1, timeout: 60_000 });
    expect(first?.variables.adHocSubProcessElements).toEqual([
      { elementId: "lookup", elementName: "lookup", documentation: "Look something up", properties: {}, parameters: [{ name: "query", description: "what to look up", type: "string" }] },
    ]);
    e.completeJob(
      first?.key as string,
      { agentContext: { turn: 1 } },
      {
        type: "adHocSubProcess",
        activateElements: [
          { elementId: "lookup", variables: { toolCall: { _meta: { id: "c1", name: "lookup" }, query: "renewal" } } },
          { elementId: "lookup", variables: { toolCall: { _meta: { id: "c2", name: "lookup" }, query: "usage" } } },
        ],
      },
    );
    const calls = e.activateJobs({ type: "lookup", worker: "w", maxJobsToActivate: 5, timeout: 60_000 });
    expect(calls.map((c) => (c.variables.args as { q: string }).q).sort()).toEqual(["renewal", "usage"]);
    e.completeJob(calls[0]?.key as string, { found: `result for ${(calls[0]?.variables.args as { q: string }).q}` });
    const second = e.activateJobs({ type: "agent", worker: "w", maxJobsToActivate: 1, timeout: 60_000 })[0];
    e.completeJob(calls[1]?.key as string, { found: `result for ${(calls[1]?.variables.args as { q: string }).q}` });
    // The second inner completion replaced the job the worker held; completing the stale one is refused.
    expect(() => e.completeJob(second?.key as string, {}, { type: "adHocSubProcess", isCompletionConditionFulfilled: true })).toThrow(/no active job/);
    const third = e.activateJobs({ type: "agent", worker: "w", maxJobsToActivate: 1, timeout: 60_000 })[0];
    expect((third?.variables.toolCallResults as unknown[]).length).toBe(2);
    expect(third?.variables.agentContext).toEqual({ turn: 1 });
    expect(third?.variables.found).toBeUndefined(); // tool variables stay inside their activation
    expect(() => e.completeJob(third?.key as string, {}, { type: "adHocSubProcess", activateElements: [{ elementId: "nope" }] })).toThrow(/cannot be activated/);
    e.completeJob(third?.key as string, { answer: "done" }, { type: "adHocSubProcess", isCompletionConditionFulfilled: true });
    expect(pi.state).toBe("COMPLETED");
    expect(pi.vars.answer).toBe("done");
    expect((pi.vars.evidence as Array<{ id: string }>).map((x) => x.id).sort()).toEqual(["c1", "c2"]);
  });
});

describe("the RevOps decisions", () => {
  it("route leads by the table and explain which rule matched", async () => {
    const e = new Engine(new ManualClock());
    await e.deploy(processResources());
    const route = (intent: string, segment: string, isCustomer = false, urgency = "normal") =>
      e.evaluateDecision("lead-routing", { classification: { intent, urgency }, lead: { segment, isCustomer, region: "EMEA" } });
    expect(route("demo_request", "Enterprise", false, "high").output).toEqual({ action: "route", queue: "EMEA Enterprise", cadenceKey: "cad-emea-demo", slaMinutes: 10 });
    expect(route("pricing", "MidMarket").output).toMatchObject({ queue: "EMEA Commercial", cadenceKey: "cad-emea-pricing", slaMinutes: 30 });
    expect(route("pricing", "SMB").output).toMatchObject({ action: "nurture", queue: "Digital Sales" });
    expect(route("support_issue", "SMB", true).output).toMatchObject({ action: "support", queue: "Customer Support" });
    expect(route("expansion", "Enterprise", true).output).toMatchObject({ queue: "Account Management" });
    expect(route("spam", "Enterprise").output).toMatchObject({ action: "discard" });
    const unknown = route("unknown", "Enterprise");
    expect(unknown.output).toMatchObject({ action: "review", queue: "Lead Review" });
    expect(unknown.matchedRules[0]?.description).toBe("Anything else needs a person");
  });

  it("send partner conflicts to a person and approve clean registrations below the limit", async () => {
    const e = new Engine(new ManualClock());
    await e.deploy(processResources());
    const decide = (kind: string, amount: number, lateStage = false) =>
      e.evaluateDecision("deal-registration-policy", { conflict: { kind, lateStage }, registration: { amount }, policy: { autoApproveMaxAmount: 50_000 } }).output;
    expect(decide("none", 20_000)).toEqual({ decision: "approve", suggestion: "approve", reasonCode: "CLEAN" });
    expect(decide("none", 80_000)).toMatchObject({ decision: "review", suggestion: "approve", reasonCode: "ABOVE_AUTO_LIMIT" });
    expect(decide("direct_open_opportunity", 10_000, true)).toMatchObject({ decision: "review", suggestion: "reject", reasonCode: "DIRECT_LATE_STAGE" });
    expect(decide("other_partner", 10_000)).toMatchObject({ decision: "review", reasonCode: "PARTNER_CONFLICT" });
  });
});

describe("deployability", () => {
  it("refuses BPMN the local engine cannot run instead of ignoring it", async () => {
    const e = new Engine();
    const multi = bpmn(
      "mi",
      `<bpmn:startEvent id="s" /><bpmn:serviceTask id="t"><bpmn:extensionElements><zeebe:taskDefinition type="x" /></bpmn:extensionElements><bpmn:multiInstanceLoopCharacteristics /></bpmn:serviceTask>${flow("f", "s", "t")}`,
    );
    await expect(e.deploy([{ name: "mi.bpmn", content: multi }])).rejects.toThrow(/multi-instance is not supported/);
    const noType = bpmn("nt", `<bpmn:startEvent id="s" /><bpmn:serviceTask id="t" />${flow("f", "s", "t")}`);
    await expect(e.deploy([{ name: "nt.bpmn", content: noType }])).rejects.toThrow(/needs zeebe:taskDefinition/);
    const dup = bpmn("dup", `<bpmn:startEvent id="dup" />`);
    await expect(e.deploy([{ name: "dup.bpmn", content: dup }])).rejects.toThrow(/duplicate ID/);
  });

  it("deploys the same file twice as one version, a changed file as the next", async () => {
    const e = new Engine();
    const res = processResources();
    const a = await e.deploy(res);
    const b = await e.deploy(res);
    expect(b.processes.map((p) => p.version)).toEqual(a.processes.map((p) => p.version));
    const changed = res.map((r) => (r.name === "inbound-lead-routing.bpmn" ? { ...r, content: r.content.replace("Lead routed", "Lead routed!") } : r));
    const c = await e.deploy(changed);
    expect(c.processes.find((p) => p.bpmnProcessId === "inbound-lead-routing")?.version).toBe(2);
  });

  it("passes Camunda's own 8.8 compatibility lint (the rules Desktop Modeler applies)", async () => {
    const { default: BpmnModdle } = await import("bpmn-moddle");
    const zeebe = JSON.parse(readFileSync(join(repoRoot(), "node_modules/zeebe-bpmn-moddle/resources/zeebe.json"), "utf8"));
    const { Linter } = await import("bpmnlint");
    const { default: NodeResolver } = await import("bpmnlint/lib/resolver/node-resolver.js");
    const linter = new Linter({ config: { extends: "plugin:camunda-compat/camunda-cloud-8-8" }, resolver: new NodeResolver() });
    const problems: string[] = [];
    for (const r of processResources().filter((x) => x.name.endsWith(".bpmn"))) {
      const { rootElement } = await new BpmnModdle({ zeebe }).fromXML(r.content);
      const results = (await linter.lint(rootElement)) as Record<string, Array<{ id: string; message: string; category: string }>>;
      for (const [rule, reports] of Object.entries(results)) for (const x of reports) if (x.category === "error") problems.push(`${r.name} ${rule} ${x.id}: ${x.message}`);
    }
    expect(problems).toEqual([]);
  });
});
