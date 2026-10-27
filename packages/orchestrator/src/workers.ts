/**
 * Job workers: one handler per job type in the BPMN. Handlers are plain functions from a job to an outcome
 * (complete, fail with back-off, or a BPMN error), so they can be tested without a cluster; `startWorkers`
 * connects them to Camunda.
 *
 * Rules the handlers keep:
 * - every GTM read and write goes through the MCP server; writes carry an approval token issued by approval.issue;
 * - a job may run twice (timeouts, retries), so posting to Slack and writing to systems are idempotent;
 * - text from customers and partners reaches a model only through the agent service, inside <input> tags;
 * - business errors the process can handle are BPMN errors (MODEL_UNAVAILABLE, NO_BRIEF); everything else fails
 *   the job, with back-off when another attempt may help and as an incident when it cannot.
 */
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { AuditLog, Clock } from "@revops/core";
import { parseDuration, sha256 } from "@revops/core";
import type { SlackClient } from "@revops/connectors";
import { argsHash, mintApproval } from "@revops/mcp-server";
import { type AgentClient, AgentServiceError, type McpGateway, ToolCallError } from "./clients";
import { automations, regionOf, segmentOf } from "./policy";
import { type ApprovalRecord, dealRegistrationApproval, decidedBlocks, leadApproval, notification, proposalHash, renewalApproval } from "./slack";

type Json = Record<string, unknown>;

export interface JobView {
  jobKey: string;
  type: string;
  elementId: string;
  elementInstanceKey: string;
  processInstanceKey: string;
  retries: number;
  variables: Json;
  customHeaders: Record<string, string>;
}

export type Outcome = { kind: "complete"; variables: Json; result?: Json } | { kind: "fail"; message: string; retries: number; backoffMs: number } | { kind: "error"; code: string; message: string };

export interface WorkerDeps {
  mcp: McpGateway;
  agent: AgentClient;
  slack: SlackClient;
  channels: Record<string, string>;
  teams: Record<string, string>;
  audit: AuditLog;
  approvalSecret: string;
  clock: Clock;
}

const complete = (variables: Json = {}, result?: Json): Outcome => ({ kind: "complete", variables, result });
const fail = (job: JobView, message: string, opts: { final?: boolean; backoffMs?: number } = {}): Outcome => {
  const left = opts.final ? 0 : Math.max(0, job.retries - 1);
  return { kind: "fail", message, retries: left, backoffMs: opts.backoffMs ?? Math.min(900_000, 5_000 * 2 ** Math.max(0, 4 - left)) };
};

const GENERIC_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "web.de", "gmx.de", "gmx.net", "icloud.com", "proton.me", "t-online.de"]);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addBusinessDays = (d: Date, n: number) => {
  const x = new Date(d);
  while (n > 0) {
    x.setUTCDate(x.getUTCDate() + 1);
    if (x.getUTCDay() !== 0 && x.getUTCDay() !== 6) n--;
  }
  return x;
};
const pick = <T>(xs: T[], key: string): T | undefined => (xs.length ? xs[Number.parseInt(sha256(key).slice(0, 8), 16) % xs.length] : undefined);
const DRIVER_LABEL: Record<string, string> = {
  usage_process_instances_change_pct: "Usage decline",
  usage_active_users_change_pct: "Fewer active users",
  health_change_12w: "Health score drop",
  champion_left: "Champion left",
  sev1_30d: "Severity-1 tickets",
  close_date_pushes: "Close date pushed",
  days_since_activity: "No recent activity",
  manager_call_weak: "Forecast slipping",
};

/** Turn errors from the MCP server and the agent service into outcomes. */
function fromError(job: JobView, e: unknown): Outcome {
  if (e instanceof ToolCallError) {
    if (e.code === "API_BUDGET_RESERVED") return fail(job, `Salesforce API budget reserved: ${e.message}`, { backoffMs: 900_000 });
    return e.retryable ? fail(job, `${e.code}: ${e.message}`) : fail(job, `${e.code}: ${e.message}`, { final: true });
  }
  if (e instanceof AgentServiceError) {
    if (e.code === "BUDGET_EXCEEDED") return fail(job, "daily model token budget used up", { backoffMs: 900_000 });
    return fail(job, `agent service ${e.code}: ${e.message}`);
  }
  return fail(job, (e as Error).message ?? String(e));
}

export function handlers(d: WorkerDeps): Record<string, (job: JobView) => Promise<Outcome>> {
  const audit = (job: JobView, action: string, outcome: "ok" | "denied" | "error" | "pending", detail: Json = {}) =>
    d.audit.append({ at: d.clock.now().toISOString(), actor: `worker:${job.type}`, action, subject: `process/${job.processInstanceKey}`, outcome, detail: { elementId: job.elementId, ...detail } });
  const team = async (role: string, region?: string) =>
    (
      await d.mcp.call<{ users: Array<{ id: string; name: string; email: string; role: string; region: string; segment: string | null; slackUserId: string }> }>("sales_team", {
        role,
        ...(region ? { region } : {}),
      })
    ).users;

  return {
    // ---- inbound lead routing ------------------------------------------------------------------------------------
    "lead.enrich": async (job) => {
      const s = (job.variables.submission ?? {}) as Json;
      const email = String(s.email ?? "").toLowerCase();
      const domain = email.includes("@") ? (email.split("@")[1] as string) : "";
      let acc: Json | undefined;
      if (domain && !GENERIC_DOMAINS.has(domain)) {
        const r = await d.mcp.call<{ accounts: Json[] }>("account_lookup", { domain });
        acc = r.accounts.find(
          (a) =>
            String(a.website ?? "")
              .replace(/^www\./, "")
              .toLowerCase() === domain,
        );
      }
      const lead = {
        submissionId: s.submissionId,
        email,
        firstName: s.firstname,
        lastName: s.lastname,
        company: s.company,
        title: s.jobtitle,
        country: s.country,
        domain,
        employeesBand: s.employees,
        region: (acc?.region as string) ?? regionOf(s.country as string) ?? "EMEA",
        segment: (acc?.segment as string) ?? segmentOf(s.employees as string),
        matchedAccountId: (acc?.id as string) ?? null,
        accountName: (acc?.name as string) ?? null,
        accountType: (acc?.type as string) ?? null,
        accountOwnerId: (acc?.ownerId as string) ?? null,
        accountOwnerName: (acc?.ownerName as string) ?? null,
        accountOwnerActive: (acc?.ownerActive as boolean) ?? null,
        isCustomer: acc?.type === "Customer",
      };
      return complete({ lead });
    },

    "agent.lead.classify": async (job) => {
      try {
        const c = await d.agent.post<Json>("/v1/lead/classify", { submission: job.variables.submission, lead: job.variables.lead });
        audit(job, "model.call", "ok", { task: "lead.classify", usage: c.usage, intent: c.intent, confidence: c.confidence, injection: c.injectionSuspected });
        const { usage: _u, ...classification } = c;
        return complete({ classification, modelUsage: { leadClassify: c.usage } });
      } catch (e) {
        if (e instanceof AgentServiceError && (e.code === "MODEL_UNAVAILABLE" || e.status === 503)) {
          audit(job, "model.call", "error", { task: "lead.classify", code: e.code });
          return { kind: "error", code: "MODEL_UNAVAILABLE", message: e.message };
        }
        return fromError(job, e);
      }
    },

    "lead.plan": async (job) => {
      const v = job.variables;
      const lead = v.lead as Json;
      const routing = v.routing as Json;
      const cls = v.classification as Json;
      const decision = v.decision as Json | undefined;
      const action = String(routing.action);
      const queue = decision?.outcome === "timeout" ? "Lead Review" : action === "review" ? "Lead Review" : String(routing.queue ?? "");
      if (["discard", "forward", "support", "partner"].includes(action) && decision?.outcome !== "timeout") {
        return complete({
          plan: { ownerId: null, ownerName: null, ownerSlackId: null, ownerReason: `no lead: ${action}`, writes: { lead: null, enroll: null, task: null }, summary: `${action}: no CRM changes` },
        });
      }
      let owner: { id: string; name: string; slackUserId: string } | undefined;
      let reason = "";
      if (queue === "Lead Review") {
        owner = (await team(automations().inbound_lead_routing.review_queue_owner_role))[0];
        reason = "lead review queue";
      } else if (lead.matchedAccountId && lead.accountOwnerActive) {
        owner = (await team("AE")).find((u) => u.id === lead.accountOwnerId) ?? (await team("CSM")).find((u) => u.id === lead.accountOwnerId);
        reason = `owner of ${lead.accountName}`;
      }
      if (!owner) {
        const aes = await team("AE", String(lead.region));
        const inSegment = aes.filter((u) => u.segment === lead.segment);
        owner = pick(inSegment.length ? inSegment : aes, String(lead.submissionId));
        reason = `${lead.matchedAccountId && lead.accountOwnerActive === false ? `account owner ${lead.accountOwnerName} is inactive; ` : ""}round robin in ${lead.region} ${lead.segment}`;
      }
      if (!owner) return fail(job, `no active owner for ${lead.region} ${lead.segment}`, { final: true });
      const sid = String(lead.submissionId);
      const leadArgs: Json = {
        submission_id: sid,
        first_name: String(lead.firstName ?? ""),
        last_name: String(lead.lastName ?? "Unknown"),
        email: String(lead.email),
        company: String(lead.company ?? ""),
        owner_id: owner.id,
        intent: String(cls.intent),
        queue,
        matched_account_id: (lead.matchedAccountId as string) ?? null,
      };
      if (lead.title) leadArgs.title = String(lead.title);
      if (lead.country) leadArgs.country = String(lead.country);
      const cadence = queue === "Lead Review" ? null : (routing.cadenceKey as string | null);
      const writes = {
        lead: { tool: "crm_upsert_lead", args: leadArgs },
        enroll: cadence
          ? {
              tool: "seq_enroll",
              args: {
                email: String(lead.email),
                first_name: String(lead.firstName ?? ""),
                last_name: String(lead.lastName ?? "Unknown"),
                title: String(lead.title ?? ""),
                company: String(lead.company ?? ""),
                cadence_id: cadence,
              },
            }
          : null,
        task: {
          tool: "crm_create_task",
          args: {
            external_key: `lead-followup-${sid}`,
            lead_submission_id: sid,
            owner_id: owner.id,
            subject: `Follow up: ${String(cls.intent).replace("_", " ")} from ${lead.company}`,
            description: `${cls.rationale ?? ""} Routed to ${queue}${decision ? ` (decided by ${decision.by})` : ""}.`.slice(0, 4000),
            due_date: isoDay(d.clock.now()),
          },
        },
      };
      return complete({
        plan: {
          ownerId: owner.id,
          ownerName: owner.name,
          ownerSlackId: owner.slackUserId,
          ownerReason: reason,
          writes,
          summary: `${queue}: ${owner.name} (${reason})${cadence ? `, cadence ${cadence}` : ""}`,
        },
      });
    },

    // ---- approvals in Slack ---------------------------------------------------------------------------------------
    "slack.approval.request": async (job) => {
      const kind = job.customHeaders.kind as "lead" | "renewal" | "deal_registration";
      const approvalId = `apv-${job.elementInstanceKey}`;
      const v = job.variables;
      const plan = (v.plan ?? {}) as Json;
      // The request is a process variable, so a retried job that already posted does not post again.
      const existing = v.approvalRequest as ApprovalRecord | undefined;
      if (existing?.approvalId === approvalId) return complete({ approvalId, shownHash: existing.proposalHash, approvalRequest: existing });
      const msg = kind === "lead" ? leadApproval(approvalId, v) : kind === "renewal" ? renewalApproval(approvalId, v) : dealRegistrationApproval(approvalId, v);
      const subjectId = String(kind === "lead" ? (v.lead as Json).submissionId : kind === "renewal" ? v.opportunityId : v.registrationId);
      const channel = d.channels[job.customHeaders.channel ?? kind] ?? d.channels.ops ?? "#revops-automation";
      const posted = await d.slack.post(channel, msg.text, msg.blocks, { event_type: "revops_approval", event_payload: { approvalId, kind, subjectId, proposal: msg.proposal } });
      const shown = proposalHash(plan.writes);
      const approvalRequest: ApprovalRecord = {
        approvalId,
        kind,
        processInstanceKey: job.processInstanceKey,
        elementInstanceKey: job.elementInstanceKey,
        subjectId,
        channel: posted.channel,
        ts: posted.ts,
        proposal: msg.proposal,
        proposalHash: shown,
        createdAt: d.clock.now().toISOString(),
      };
      audit(job, "approval.requested", "pending", { approvalId, kind, subjectId });
      return complete({ approvalId, shownHash: shown, approvalRequest });
    },

    "slack.approval.close": async (job) => {
      const rec = job.variables.approvalRequest as ApprovalRecord | undefined;
      if (!rec) return complete();
      const decision = job.variables.decision as { outcome?: string; by?: string } | undefined;
      const outcome = job.customHeaders.outcome ?? "done";
      const by = decision?.by && String(decision.by).startsWith("slack:") ? String(decision.by) : "the deadline";
      await d.slack.update(
        rec.channel,
        rec.ts,
        `Closed: ${outcome}`,
        decidedBlocks(`*${rec.kind.replace("_", " ")}* ${rec.subjectId}`, outcome === "expired" ? "expired" : (decision?.outcome ?? "approve"), by),
      );
      return complete();
    },

    "approval.issue": async (job) => {
      const v = job.variables;
      const writes = (v.writes ?? {}) as Record<string, { tool: string; args: Json } | null>;
      const approvedBy = String(v.approvedBy ?? "");
      const decision = v.decision as Json | undefined;
      if (approvedBy.startsWith("slack:") && decision?.outcome === "approve" && v.shownHash && proposalHash((v.plan as Json | undefined)?.writes) !== v.shownHash) {
        audit(job, "approval.refused", "denied", { reason: "changes differ from what the person approved" });
        return fail(job, "the changes differ from what the person approved; not issuing an approval", { final: true });
      }
      const ttl = Math.round(parseDuration(automations().approvals.token_ttl) / 1000);
      const approvals: Record<string, string> = {};
      for (const [slot, w] of Object.entries(writes)) {
        if (!w) continue;
        approvals[slot] = mintApproval(d.approvalSecret, { tool: w.tool, argsHash: argsHash(w.args), instance: job.processInstanceKey, approvedBy, ttlSeconds: ttl, nowMs: d.clock.now().getTime() });
      }
      audit(job, "approval.issued", "ok", {
        approvedBy,
        slots: Object.keys(approvals),
        tools: Object.values(writes)
          .filter(Boolean)
          .map((w) => w?.tool),
      });
      return complete({ approvals });
    },

    // ---- MCP tools as service tasks -------------------------------------------------------------------------------
    "mcp.call": async (job) => {
      const tool = job.customHeaders.tool;
      if (!tool) return fail(job, "the task has no 'tool' header", { final: true });
      const v = job.variables;
      const args = { ...((v.args ?? {}) as Json), ...(v.approval ? { approval_token: v.approval } : {}) };
      const forAgent = v.toolCall !== undefined;
      try {
        const toolResult = await d.mcp.call(tool, args);
        return complete({ toolResult });
      } catch (e) {
        // An agent's bad call is information for the agent, not an incident.
        if (forAgent && e instanceof ToolCallError && !e.retryable) return complete({ toolResult: { error: e.code, message: e.message } });
        audit(job, "tool.failed", "error", { tool, code: (e as ToolCallError).code });
        return fromError(job, e);
      }
    },

    // ---- renewal risk -----------------------------------------------------------------------------------------------
    "agent.renewal.investigate": async (job) => {
      const v = job.variables;
      const prior = (v.agent ?? {}) as Json;
      try {
        const r = await d.agent.post<{ action: string; toolCalls: Array<{ id: string; elementId: string; arguments: Json }>; brief?: Json; reason?: string; state: Json; stats: Json }>(
          "/v1/renewal/next",
          {
            context: { opportunityId: v.opportunityId, accountId: v.accountId, trigger: v.trigger ?? "signal" },
            tools: v.adHocSubProcessElements ?? [],
            results: v.toolCallResults ?? [],
            state: prior.state ?? null,
          },
        );
        if (r.action === "wait") return complete({}, { type: "adHocSubProcess", activateElements: [], isCompletionConditionFulfilled: false, isCancelRemainingInstances: false });
        audit(job, "agent.turn", r.action === "give_up" ? "error" : "ok", { action: r.action, tools: r.toolCalls.map((t) => t.elementId), stats: r.stats });
        if (r.action === "give_up") return { kind: "error", code: "NO_BRIEF", message: r.reason ?? "the agent gave up" };
        if (r.action === "finish")
          return complete(
            { agent: { brief: r.brief, stats: r.stats, state: { ...r.state, messages: undefined } } },
            { type: "adHocSubProcess", activateElements: [], isCompletionConditionFulfilled: true, isCancelRemainingInstances: false },
          );
        return complete(
          { agent: { state: r.state, stats: r.stats } },
          {
            type: "adHocSubProcess",
            activateElements: r.toolCalls.map((t) => ({ elementId: t.elementId, variables: { toolCall: { _meta: { id: t.id, name: t.elementId }, ...t.arguments } } })),
            isCompletionConditionFulfilled: false,
            isCancelRemainingInstances: false,
          },
        );
      } catch (e) {
        if (e instanceof AgentServiceError && (e.code === "MODEL_UNAVAILABLE" || e.status === 503)) return { kind: "error", code: "NO_BRIEF", message: `model unavailable: ${e.message}` };
        return fromError(job, e);
      }
    },

    "agent.brief.verify": async (job) => {
      try {
        const verification = await d.agent.post<Json>("/v1/brief/verify", { brief: job.variables.brief ?? null, evidence: job.variables.evidence ?? [] });
        audit(job, "brief.verified", verification.grounded ? "ok" : "denied", {
          grounded: verification.grounded,
          riskProbability: verification.riskProbability,
          unsupported: (verification.unsupported as unknown[]).length,
        });
        return complete({ verification });
      } catch (e) {
        return fromError(job, e);
      }
    },

    "renewal.plan": async (job) => {
      const v = job.variables;
      const evidence = (v.evidence ?? []) as Array<{ name: string; content: Json }>;
      const a360 = evidence.find((e) => e.content && "facts" in e.content)?.content as { account: Json; facts: Array<{ id: string }> } | undefined;
      if (!a360) return fail(job, "no account facts in the evidence", { final: true });
      const account = a360.account;
      const ver = v.verification as { riskProbability: number; riskDrivers: Array<{ feature: string }> };
      const brief = (v.brief ?? {}) as { summary?: string; recommendedPlay?: { title: string; passageId: string } | null; claims?: Array<{ cites: string[] }> };
      const csms = await team("CSM");
      const csm =
        csms.find((u) => u.id === account.csmId) ??
        pick(
          csms.filter((u) => u.region === account.region),
          String(account.id),
        );
      if (!csm) return fail(job, "no active CSM for the account", { final: true });
      const due = isoDay(addBusinessDays(d.clock.now(), 5));
      const reason = DRIVER_LABEL[ver.riskDrivers[0]?.feature ?? ""] ?? "Renewal risk";
      const cites = [...new Set((brief.claims ?? []).flatMap((c) => c.cites))].join(", ");
      const opp = String(v.opportunityId);
      const writes = {
        cta: {
          tool: "cs_create_cta",
          args: {
            reference_id: `renewal-risk-${opp}`,
            account_id: String(account.id),
            owner_email: csm.email,
            name: `Renewal at risk: ${account.name}`.slice(0, 200),
            reason,
            priority: ver.riskProbability >= 0.9 ? "High" : "Medium",
            due_date: due,
            comments: `${brief.summary ?? ""} Play: ${brief.recommendedPlay?.title ?? "to choose"} (${brief.recommendedPlay?.passageId ?? "-"}). Facts: ${cites}.`.slice(0, 4000),
          },
        },
        task: {
          tool: "crm_create_task",
          args: {
            external_key: `renewal-save-${opp}`,
            what_id: opp,
            owner_id: csm.id,
            subject: `Save play: ${brief.recommendedPlay?.title ?? reason}`.slice(0, 255),
            description: `${brief.summary ?? ""} Calibrated risk ${Math.round(ver.riskProbability * 100)} %.`.slice(0, 4000),
            due_date: due,
          },
        },
      };
      return complete({
        plan: {
          accountName: account.name,
          csmId: csm.id,
          csmName: csm.name,
          csmSlackId: csm.slackUserId,
          writes,
          summary: `CTA for ${csm.name} due ${due} (${reason}); task on the renewal opportunity.`,
        },
      });
    },

    // ---- partner deal registration --------------------------------------------------------------------------------
    "dealreg.conflicts": async (job) => {
      const id = String(job.variables.registrationId);
      const { registration } = await d.mcp.call<{ registration: Json }>("deal_registration", { registration_id: id });
      const domain = String(registration.domain).toLowerCase();
      // Duplicate accounts can share a domain: check every account the domain belongs to.
      const accounts = (await d.mcp.call<{ accounts: Json[] }>("account_lookup", { domain })).accounts.filter(
        (a) =>
          String(a.website ?? "")
            .replace(/^www\./, "")
            .toLowerCase() === domain,
      );
      const acc = accounts[0];
      const opps = (await Promise.all(accounts.map(async (a) => (await d.mcp.call<{ opportunities: Json[] }>("open_opportunities", { account_id: a.id })).opportunities))).flat();
      const direct = opps.filter((o) => o.type === "New Business" && !o.partnerAccountId);
      const regs = (await d.mcp.call<{ registrations: Json[] }>("partner_registrations", { domain })).registrations;
      const other = regs.filter((r) => r.id !== id && r.status === "Approved" && r.partnerId !== registration.partnerId);
      const kind = direct.length ? "direct_open_opportunity" : other.length ? "other_partner" : "none";
      const partner = (await d.mcp.call<{ accounts: Json[] }>("account_lookup", { account_id: registration.partnerId })).accounts[0] ?? {};
      const otherNames = await Promise.all(other.map(async (r) => ((await d.mcp.call<{ accounts: Json[] }>("account_lookup", { account_id: r.partnerId })).accounts[0]?.name as string) ?? ""));
      const conflict = {
        kind,
        lateStage: direct.some((o) => ["Proposal", "Negotiation"].includes(String(o.stage))),
        accountId: acc?.id ?? null,
        duplicateAccounts: accounts.length > 1 ? accounts.map((a) => a.id) : [],
        opportunityIds: direct.map((o) => o.id),
        conflictingRegistrationIds: other.map((r) => r.id),
      };
      const confidential = [...direct.map((o) => String(o.name)), ...direct.map((o) => String(o.amount)), ...otherNames].filter((x) => x && x !== "undefined");
      return complete({ registration, conflict, partner: { id: partner.id ?? registration.partnerId, name: partner.name ?? null }, confidential });
    },

    "agent.dealreg.draft": async (job) => {
      const v = job.variables;
      try {
        const passages = (await d.mcp.call<{ passages: Json[] }>("playbook_search", { query: "deal registration decisions conflict approve reject escalate", k: 3 })).passages;
        const draft = await d.agent.post<Json>("/v1/dealreg/draft", {
          registration: v.registration,
          conflict: v.conflict,
          policyDecision: v.policyDecision,
          partner: v.partner,
          passages,
          confidential: v.confidential ?? [],
        });
        audit(job, "model.call", "ok", { task: "dealreg.draft", usage: draft.usage, withheld: draft.withheld });
        const reg = v.registration as Json;
        const suggestion = String((v.policyDecision as Json).suggestion);
        const company = String(reg.companyName);
        const approveText =
          suggestion === "approve" ? String(draft.partnerMessage) : `Thank you for registering ${company}. After review, the registration is approved and the deal is protected for your team.`;
        const rejectText =
          suggestion === "reject"
            ? String(draft.partnerMessage)
            : `Thank you for registering ${company}. After review, we cannot approve this registration. Your partner manager will explain the reasons.`;
        const writes = {
          approve: { tool: "prm_decide_registration", args: { registration_id: String(reg.id), decision: "Approved", reason: approveText.slice(0, 1000) } },
          reject: { tool: "prm_decide_registration", args: { registration_id: String(reg.id), decision: "Rejected", reason: rejectText.slice(0, 1000) } },
        };
        const { usage: _u, ...rest } = draft;
        return complete({ draft: rest, plan: { writes } });
      } catch (e) {
        return fromError(job, e);
      }
    },

    // ---- notifications ------------------------------------------------------------------------------------------
    "slack.notify": async (job) => {
      const v = job.variables;
      const key = job.customHeaders.channel ?? "ops";
      const channel =
        key === "owner"
          ? String((v.plan as Json | undefined)?.ownerSlackId ?? d.channels.ops)
          : key === "routed_team"
            ? (d.teams[String((v.routing as Json | undefined)?.queue)] ?? d.channels.ops ?? "#revops-automation")
            : (d.channels[key] ?? d.channels.ops ?? "#revops-automation");
      const n = notification(job.customHeaders.template ?? "generic", v);
      await d.slack.post(channel, n.text, n.blocks);
      return complete();
    },
  };
}

export const JOB_TYPES = [
  "lead.enrich",
  "agent.lead.classify",
  "lead.plan",
  "slack.approval.request",
  "slack.approval.close",
  "approval.issue",
  "mcp.call",
  "agent.renewal.investigate",
  "agent.brief.verify",
  "renewal.plan",
  "dealreg.conflicts",
  "agent.dealreg.draft",
  "slack.notify",
] as const;

/** Apply an outcome through the Orchestration Cluster API. */
export async function applyOutcome(client: CamundaClient, job: JobView, o: Outcome): Promise<void> {
  if (o.kind === "complete") await client.completeJob({ jobKey: job.jobKey, variables: o.variables, ...(o.result ? { result: o.result } : {}) } as never);
  else if (o.kind === "fail") await client.failJob({ jobKey: job.jobKey, retries: o.retries, errorMessage: o.message, retryBackOff: o.backoffMs } as never);
  else await client.throwJobError({ jobKey: job.jobKey, errorCode: o.code, errorMessage: o.message } as never);
}

/** Connect the handlers to Camunda as job workers. */
export function startWorkers(client: CamundaClient, d: WorkerDeps, opts: { pollIntervalMs?: number; maxParallelJobs?: number } = {}): { stop: () => Promise<void> } {
  const hs = handlers(d);
  const workers = JOB_TYPES.map((type) =>
    client.createJobWorker({
      jobType: type,
      workerName: `revops-${type}`,
      jobTimeoutMs: type.startsWith("agent.") ? 120_000 : 60_000,
      maxParallelJobs: opts.maxParallelJobs ?? 8,
      pollIntervalMs: opts.pollIntervalMs ?? 50,
      pollTimeoutMs: 1_000,
      jobHandler: async (job) => {
        const view: JobView = {
          jobKey: String(job.jobKey),
          type: job.type,
          elementId: job.elementId,
          elementInstanceKey: String(job.elementInstanceKey),
          processInstanceKey: String(job.processInstanceKey),
          retries: job.retries,
          variables: job.variables as Json,
          customHeaders: job.customHeaders as Record<string, string>,
        };
        let outcome: Outcome;
        try {
          outcome = await (hs[type] as (j: JobView) => Promise<Outcome>)(view);
        } catch (e) {
          outcome = fromError(view, e);
        }
        try {
          await applyOutcome(client, view, outcome);
        } catch {
          // The job may have been replaced (an ad-hoc job after another tool finished) or timed out; Camunda re-delivers.
        }
        return job.ignore();
      },
    }),
  );
  return { stop: async () => void (await Promise.all(workers.map((w) => w.stopGracefully({ timeoutMs: 3000 } as never)))) };
}
