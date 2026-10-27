/**
 * Every approval request lives in Camunda, as process variables of the instance that asked:
 *   approvalRequest  written by slack.approval.request (who was asked where, what they were shown)
 *   decision         the answer, correlated from Slack (or the policy's answer when a deadline passed)
 * The orchestrator keeps no database of its own, so its Cloud Run instances are stateless and a restart loses
 * nothing: an open request is simply an active instance with a request and no decision.
 */
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { ApprovalRecord } from "./slack";

type Json = Record<string, unknown>;
const now0 = { consistency: { waitUpToMs: 0 } };
const PAGE = 1000;

export class Approvals {
  constructor(private readonly camunda: CamundaClient) {}

  private async variables(name: string): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    for (let from = 0; ; from += PAGE) {
      const r = await this.camunda.searchVariables({ filter: { name }, page: { from, limit: PAGE } } as never, now0 as never);
      for (const v of r.items ?? []) {
        if (String(v.scopeKey) !== String(v.processInstanceKey)) continue;
        try {
          out.set(String(v.processInstanceKey), JSON.parse(String(v.value)));
        } catch {
          /* not JSON */
        }
      }
      if ((r.items ?? []).length < PAGE) return out;
    }
  }

  private async activeInstances(): Promise<Set<string>> {
    const out = new Set<string>();
    for (let from = 0; ; from += PAGE) {
      const r = await this.camunda.searchProcessInstances({ filter: { state: "ACTIVE" }, page: { from, limit: PAGE } } as never, now0 as never);
      for (const p of r.items ?? []) out.add(String(p.processInstanceKey));
      if ((r.items ?? []).length < PAGE) return out;
    }
  }

  async list(filter: (r: ApprovalRecord) => boolean = () => true): Promise<ApprovalRecord[]> {
    const [requests, decisions, active] = await Promise.all([this.variables("approvalRequest"), this.variables("decision"), this.activeInstances()]);
    const out: ApprovalRecord[] = [];
    for (const [pik, req] of requests) {
      const r = req as ApprovalRecord;
      const d = decisions.get(pik) as (Json & { outcome: string; by: string; at?: string; edits?: Json | null }) | undefined;
      const byPerson = d && String(d.by).startsWith("slack:");
      out.push({
        ...r,
        processInstanceKey: pik,
        ...(byPerson ? { decision: { outcome: d.outcome, by: d.by, edits: d.edits ?? null }, decidedAt: d.at ?? r.createdAt, override: d.outcome !== "approve" } : {}),
        ...(!active.has(pik) || (d && !byPerson) ? { closedAt: r.createdAt, closedAs: d && !byPerson ? String(d.outcome) : "finished" } : {}),
      });
    }
    return out.filter(filter);
  }
}

export const isOpen = (r: ApprovalRecord) => !r.decision && !r.closedAt;
