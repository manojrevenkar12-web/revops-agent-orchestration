import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getJson, type Overview } from "../../shared/api/client";
import { layout } from "../../shared/theme/theme";
import { EmptyState, Loadable, Skeleton } from "../../shared/ui/states";
import { PageHeader, pct, Reveal } from "../../shared/ui/ui";
import { FlowLane } from "./FlowLane";

export function OverviewPage() {
  const q = useQuery({ queryKey: ["overview"], queryFn: () => getJson<Overview>("/api/overview"), refetchInterval: layout.refreshMs });
  return (
    <>
      <PageHeader title="What the automations did" lead="Every case each automation handled, and who decided it: the policy on its own, or a person in Slack." />
      <Loadable
        query={q}
        skeleton={<Skeleton rows={6} height={28} label="Loading the overview" />}
        isEmpty={(o) => o.lanes.every((l) => l.total === 0)}
        empty={<EmptyState title="No cases yet">Cases appear here when a HubSpot form arrives, the weekly renewal scan runs, or a partner registers a deal.</EmptyState>}
      >
        {(o) => (
          <>
            <Reveal>
              <div className="lanes">
                {o.lanes.map((l, i) => (
                  <FlowLane key={l.id} lane={l} index={i} />
                ))}
              </div>
            </Reveal>
            <Reveal delay={0.3}>
              <h2>Can people trust it</h2>
              <dl className="facts">
                <div>
                  <dt>People changed the proposal</dt>
                  <dd className="num">{o.approvals.decided ? `${pct(o.approvals.overrideRate)} of ${o.approvals.decided} decisions` : "no decisions yet"}</dd>
                </div>
                <div>
                  <dt>Renewal briefs that matched the facts</dt>
                  <dd className="num">{o.renewals.investigated ? `${o.renewals.grounded} of ${o.renewals.investigated}` : "none investigated yet"}</dd>
                </div>
                <div>
                  <dt>Median time to a person's decision</dt>
                  <dd className="num">{o.approvals.medianMinutesToDecision === null ? "–" : `${Math.round(o.approvals.medianMinutesToDecision)} min`}</dd>
                </div>
                <div>
                  <dt>Open incidents</dt>
                  <dd className="num">{o.incidents === 0 ? "none" : <Link to="/instances?incidents=1">{o.incidents}</Link>}</dd>
                </div>
              </dl>
            </Reveal>
            <Reveal delay={0.4}>
              <h2>What it cost and saved</h2>
              <dl className="facts">
                <div>
                  <dt>Time given back to the team</dt>
                  <dd className="num">{o.hoursSaved} h</dd>
                </div>
                <div>
                  <dt>Model calls</dt>
                  <dd className="num">
                    {o.models.calls} ({Math.round((o.models.inputTokens + o.models.outputTokens) / 1000)}k tokens)
                  </dd>
                </div>
                <div>
                  <dt>Model cost</dt>
                  <dd className="num">{o.models.costKnown && o.models.costUsd !== null ? `$${o.models.costUsd.toFixed(2)}` : "not priced (set prices in config/agent.yaml)"}</dd>
                </div>
                <div>
                  <dt>Answers repaired / model unavailable</dt>
                  <dd className="num">
                    {o.models.repairs} / {o.models.unavailable}
                  </dd>
                </div>
              </dl>
              <p className="footnote">
                Time given back counts the triage minutes the teams measured per case (config/automations.yaml), for cases the policy decided or a person decided on a prepared proposal.
              </p>
            </Reveal>
          </>
        )}
      </Loadable>
    </>
  );
}
