import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { type Approval, getJson } from "../../shared/api/client";
import { layout } from "../../shared/theme/theme";
import { EmptyState, Loadable, Skeleton } from "../../shared/ui/states";
import { PageHeader, Tag, when } from "../../shared/ui/ui";

const KIND: Record<Approval["kind"], string> = { lead: "Lead", renewal: "Save play", deal_registration: "Deal registration" };

function summary(a: Approval): string {
  const p = a.proposal as { intent?: string; queue?: string; decision?: string; reasonCode?: string };
  if (a.kind === "lead") return `${p.intent ?? "?"} → ${p.queue ?? "?"}`;
  if (a.kind === "deal_registration") return `${p.decision ?? "?"} (${p.reasonCode ?? "?"})`;
  return "CTA and renewal task";
}

export function ApprovalsPage() {
  const [state, setState] = useState<"open" | "decided">("open");
  const q = useQuery({ queryKey: ["approvals", state], queryFn: () => getJson<{ items: Approval[] }>(`/api/approvals?state=${state}`), refetchInterval: layout.refreshMs });
  return (
    <>
      <PageHeader title="Decisions in Slack" lead="What the automations asked people, and what they answered. A changed or declined proposal counts as an override." />
      <div className="segmented" role="tablist" aria-label="Which decisions">
        {(["open", "decided"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={state === s} className={state === s ? "on" : ""} onClick={() => setState(s)}>
            {s === "open" ? "Waiting" : "Decided"}
          </button>
        ))}
      </div>
      <Loadable
        query={q}
        skeleton={<Skeleton rows={8} label="Loading decisions" />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState title={state === "open" ? "Nobody is waiting on a decision" : "No decisions yet"}>
            {state === "open" ? "New requests appear here when the policy asks a person." : "Decisions appear when people answer in Slack."}
          </EmptyState>
        }
      >
        {(d) => (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Asked</th>
                <th scope="col">Kind</th>
                <th scope="col">Proposal</th>
                <th scope="col">Channel</th>
                <th scope="col">{state === "open" ? "Waiting since" : "Decision"}</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((a) => (
                <tr key={a.approvalId}>
                  <td>
                    <Link to={`/instances/${a.processInstanceKey}`}>{a.subjectId}</Link>
                  </td>
                  <td>{KIND[a.kind]}</td>
                  <td>{summary(a)}</td>
                  <td>{a.channel}</td>
                  <td>
                    {a.decision ? (
                      <Tag kind={a.override ? "waiting" : "person"}>
                        {a.decision.outcome === "approve" ? "approved" : a.decision.outcome === "edit" ? "changed" : "declined"} by {a.decision.by.replace("slack:", "")}
                      </Tag>
                    ) : (
                      <span className="num">{when(a.createdAt)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Loadable>
    </>
  );
}
