/**
 * What the revenue team and the automation owners look at: how much work the automations took over, how often
 * people disagreed with them, how fast leads were handled, what the models cost and how long they took.
 * Computed from the audit log (the record of every decision and model call) and the approval records, so the
 * numbers on the console can be traced to individual events.
 */
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { AuditEntry, AuditLog } from "@revops/core";
import { automations } from "./policy";
import type { ApprovalStore } from "./slack";

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};

export interface Overview {
  generatedAt: string;
  processes: Array<{ id: string; active: number; completed: number; incidents: number }>;
  leads: { received: number; autoRouted: number; personDecided: number; overrides: number; overrideRate: number | null; speedToLeadMinutes: { p50: number | null; p90: number | null } };
  renewals: { investigated: number; grounded: number; ungrounded: number; proposed: number; approved: number; declined: number };
  registrations: { autoApproved: number; reviewed: number };
  approvals: { open: number; decided: number; overrideRate: number | null; medianMinutesToDecision: number | null };
  hoursSaved: number;
  models: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    costKnown: boolean;
    repairs: number;
    latencyMs: { p50: number | null; p95: number | null };
    unavailable: number;
  };
  incidents: number;
}

export async function computeMetrics(d: { audit: AuditLog; approvals: ApprovalStore; camunda?: CamundaClient; now: Date }): Promise<Overview> {
  const all = d.audit.list(() => true, 1_000_000);
  const by = (action: string) => all.filter((e) => e.action === action);
  const cfg = automations();

  // leads: from the webhook to the approval that let the lead be written
  const received = by("webhook.received");
  const issued = by("approval.issued");
  const leadIssued = issued.filter((e) => String(e.detail.elementId) === "IssueApprovals");
  const auto = leadIssued.filter((e) => String(e.detail.approvedBy).startsWith("policy:inbound"));
  const person = leadIssued.filter((e) => String(e.detail.approvedBy).startsWith("slack:"));
  const startedAt = new Map<string, number>();
  for (const e of by("approval.requested").concat(issued)) if (!startedAt.has(e.subject)) startedAt.set(e.subject, Date.parse(e.at));
  const firstEvent = new Map<string, number>();
  for (const e of all) if (e.subject.startsWith("process/") && !firstEvent.has(e.subject)) firstEvent.set(e.subject, Date.parse(e.at));
  const speed = leadIssued.map((e) => (Date.parse(e.at) - (firstEvent.get(e.subject) ?? Date.parse(e.at))) / 60_000);

  const decided = d.approvals.list((r) => !!r.decision);
  const leadDecided = decided.filter((r) => r.kind === "lead");
  const overrides = leadDecided.filter((r) => r.override).length;

  // renewals
  const verified = by("brief.verified");
  const renewalDecided = decided.filter((r) => r.kind === "renewal");
  const regIssued = issued.filter((e) => String(e.detail.elementId) === "IssueDealApproval");

  // models
  // Single calls are logged once; an investigation logs cumulative totals on every turn, so take its last turn.
  const single = all.filter((e) => e.action === "model.call");
  const lastTurn = new Map<string, AuditEntry>();
  for (const e of all) if (e.action === "agent.turn") lastTurn.set(e.subject, e);
  const turns = all.filter((e) => e.action === "agent.turn");
  const calls = [...single, ...turns];
  type U = { inputTokens?: number; outputTokens?: number; latencyMs?: number; costUsd?: number | null; repairs?: number; provider?: string; modelCalls?: number };
  const usage: U[] = [...single.map((e) => (e.detail.usage ?? {}) as U), ...[...lastTurn.values()].map((e) => (e.detail.stats ?? {}) as U)];
  const costs = usage.map((u) => (typeof u.costUsd === "number" ? u.costUsd : u.provider === "simulated" ? 0 : null));
  const costKnown = costs.every((c) => typeof c === "number");
  const minutesSaved =
    auto.length * cfg.inbound_lead_routing.minutes_saved_per_auto_route +
    person.length * cfg.inbound_lead_routing.minutes_saved_per_assisted_route +
    verified.filter((e) => e.detail.grounded).length * cfg.renewal_risk.minutes_saved_per_brief +
    regIssued.filter((e) => String(e.detail.approvedBy).startsWith("policy:")).length * cfg.partner_deal_registration.minutes_saved_per_registration;

  const processes: Overview["processes"] = [];
  let incidents = 0;
  if (d.camunda) {
    const c0 = { consistency: { waitUpToMs: 0 } };
    for (const id of [cfg.inbound_lead_routing.process_id, cfg.renewal_risk.process_id, cfg.partner_deal_registration.process_id]) {
      const count = async (state: string) =>
        Number((await d.camunda?.searchProcessInstances({ filter: { processDefinitionId: id, state }, page: { limit: 1 } } as never, c0 as never))?.page?.totalItems ?? 0);
      const inc = Number(
        (await d.camunda.searchProcessInstances({ filter: { processDefinitionId: id, state: "ACTIVE", hasIncident: true }, page: { limit: 1 } } as never, c0 as never)).page?.totalItems ?? 0,
      );
      processes.push({ id, active: await count("ACTIVE"), completed: await count("COMPLETED"), incidents: inc });
      incidents += inc;
    }
  }
  const decisionMinutes = decided.map((r) => (Date.parse(r.decidedAt as string) - Date.parse(r.createdAt)) / 60_000);
  return {
    generatedAt: d.now.toISOString(),
    processes,
    leads: {
      received: received.length,
      autoRouted: auto.length,
      personDecided: leadDecided.length,
      overrides,
      overrideRate: leadDecided.length ? overrides / leadDecided.length : null,
      speedToLeadMinutes: { p50: quantile(speed, 0.5), p90: quantile(speed, 0.9) },
    },
    renewals: {
      investigated: verified.length,
      grounded: verified.filter((e) => e.detail.grounded).length,
      ungrounded: verified.filter((e) => !e.detail.grounded).length,
      proposed: d.approvals.list((r) => r.kind === "renewal").length,
      approved: renewalDecided.filter((r) => r.decision?.outcome === "approve").length,
      declined: renewalDecided.filter((r) => r.decision?.outcome === "reject").length,
    },
    registrations: { autoApproved: regIssued.filter((e) => String(e.detail.approvedBy).startsWith("policy:")).length, reviewed: d.approvals.list((r) => r.kind === "deal_registration").length },
    approvals: {
      open: d.approvals.list((r) => !r.decision && !r.closedAt).length,
      decided: decided.length,
      overrideRate: decided.length ? decided.filter((r) => r.override).length / decided.length : null,
      medianMinutesToDecision: quantile(decisionMinutes, 0.5),
    },
    hoursSaved: Math.round((minutesSaved / 60) * 10) / 10,
    models: {
      calls: single.length + usage.slice(single.length).reduce((n, u) => n + (u.modelCalls ?? 1), 0),
      inputTokens: usage.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
      outputTokens: usage.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
      costUsd: costKnown ? Math.round(costs.reduce<number>((s, c) => s + (c ?? 0), 0) * 10000) / 10000 : null,
      costKnown,
      repairs: usage.reduce((s, u) => s + (u.repairs ?? 0), 0),
      latencyMs: {
        p50: quantile(
          usage.map((u) => u.latencyMs ?? 0),
          0.5,
        ),
        p95: quantile(
          usage.map((u) => u.latencyMs ?? 0),
          0.95,
        ),
      },
      unavailable: calls.filter((e) => e.outcome === "error").length,
    },
    incidents,
  };
}

export type { AuditEntry };
