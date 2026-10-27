import { useQuery } from "@tanstack/react-query";
import { getJson, type Tool } from "../../shared/api/client";
import { EmptyState, Loadable, Skeleton } from "../../shared/ui/states";
import { PageHeader, Reveal, Tag } from "../../shared/ui/ui";

interface Policy {
  automations: Record<string, Record<string, unknown>>;
}

const POLICY_KEYS: Record<string, string[]> = {
  inbound_lead_routing: ["mode", "auto_route_min_probability", "never_auto_segments", "review_timeout"],
  renewal_risk: ["mode", "create_cta_min_probability", "approval_deadline", "agent_time_budget"],
  partner_deal_registration: ["mode", "auto_approve_max_amount", "decision_deadline"],
};

export function CataloguePage() {
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => getJson<{ tools: Tool[] }>("/api/tools") });
  const policy = useQuery({ queryKey: ["policy"], queryFn: () => getJson<Policy>("/api/policy") });
  return (
    <>
      <PageHeader title="Tools and policy" lead="The GTM tools the MCP server offers, and the limits within which the automations decide on their own." />
      <Reveal>
        <h2>Policy</h2>
        <Loadable query={policy} skeleton={<Skeleton rows={4} label="Loading the policy" />}>
          {(p) => (
            <div className="policy">
              {Object.entries(POLICY_KEYS).map(([k, keys]) => (
                <dl key={k} className="facts compact">
                  <h3>{k.replace(/_/g, " ")}</h3>
                  {keys.map((key) => (
                    <div key={key}>
                      <dt>{key.replace(/_/g, " ")}</dt>
                      <dd className="num">{JSON.stringify(p.automations[k]?.[key])}</dd>
                    </div>
                  ))}
                </dl>
              ))}
            </div>
          )}
        </Loadable>
      </Reveal>
      <Reveal delay={0.15}>
        <h2>MCP tools</h2>
        <Loadable
          query={tools}
          skeleton={<Skeleton rows={8} label="Loading the tools" />}
          isEmpty={(d) => d.tools.length === 0}
          empty={<EmptyState title="The MCP server offers no tools to the orchestrator" />}
        >
          {(d) => (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">What it does</th>
                  <th scope="col">Changes data</th>
                </tr>
              </thead>
              <tbody>
                {d.tools.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <code>{t.name}</code>
                    </td>
                    <td>{t.description}</td>
                    <td>{t.annotations?.readOnlyHint ? <Tag kind="none">read only</Tag> : <Tag kind="person">needs an approval</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Loadable>
      </Reveal>
    </>
  );
}
