/**
 * Renewal signals from Salesforce Change Data Capture: when a renewal's close date moves later, the renewal is
 * investigated now instead of at the next weekly scan.
 *
 * This is the one place the orchestrator reads Salesforce directly (an event stream is not a tool call): it uses a
 * read-only integration user, keeps its replay position after each handled event, and re-reads what changed with a
 * Bulk API query when it was down longer than Salesforce keeps events (connectors/cdc.ts).
 */
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { AuditLog, Clock } from "@revops/core";
import type { ChangeEvent, ChangeSubscriber } from "@revops/connectors";
import type { McpGateway } from "./clients";
import { automations, renewalPolicy } from "./policy";

export const OPPORTUNITY_TOPIC = "/data/OpportunityChangeEvent";

export function renewalSignalHandler(d: { camunda: CamundaClient; mcp: McpGateway; audit: AuditLog; clock: Clock }) {
  return async (e: ChangeEvent): Promise<void> => {
    const h = e.payload.ChangeEventHeader;
    if (h.changeType !== "UPDATE" || !h.changedFields.includes("CloseDate")) return;
    for (const id of h.recordIds) {
      const { renewals } = await d.mcp.call<{ renewals: Array<{ opportunityId: string; accountId: string; closeDate: string }> }>("renewals_due", { opportunity_id: id });
      const r = renewals[0];
      if (!r) continue; // not an open renewal
      const cfg = automations().renewal_risk;
      try {
        await d.camunda.publishMessage({
          name: cfg.message,
          correlationKey: r.opportunityId,
          messageId: `cdc-${r.opportunityId}-${r.closeDate}`,
          timeToLive: 0,
          variables: { opportunityId: r.opportunityId, accountId: r.accountId, trigger: e.resync ? "resync" : "close_date_moved", policy: renewalPolicy() },
        } as never);
        d.audit.append({
          at: d.clock.now().toISOString(),
          actor: "cdc",
          action: "renewal.signal",
          subject: `opportunity/${r.opportunityId}`,
          outcome: "ok",
          detail: { closeDate: r.closeDate, resync: !!e.resync },
        });
      } catch (err) {
        if (!/ALREADY_EXISTS|already/.test(String((err as Error).message))) throw err;
      }
    }
  };
}

/** Poll the stream every `everyMs` (Cloud Run job or a long-running worker in production). */
export function startCdc(sub: ChangeSubscriber, handle: (e: ChangeEvent) => Promise<void>, everyMs = 5000): { stop: () => void } {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        await sub.poll(OPPORTUNITY_TOPIC, handle);
      } catch {
        /* logged by the caller's audit; the next poll resumes from the stored position */
      }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  };
  void loop();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
