import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, getJson, type InstanceDetail as Detail } from "../../shared/api/client";
import { EmptyState, Loadable, Skeleton } from "../../shared/ui/states";
import { PageHeader, PROCESS_NAMES, Reveal, Tag, when } from "../../shared/ui/ui";
import { AuditList } from "../audit/AuditList";
import { BpmnDiagram } from "./BpmnDiagram";

function Path({ d }: { d: Detail }) {
  const ids = useMemo(() => {
    const done = d.elements.filter((e) => e.state === "COMPLETED").map((e) => e.elementId);
    const active = d.elements.filter((e) => e.state === "ACTIVE" && !e.hasIncident).map((e) => e.elementId);
    const incidents = d.elements.filter((e) => e.hasIncident).map((e) => e.elementId);
    return { done, active, incidents };
  }, [d]);
  if (!d.xml) return <p className="state-text">The process diagram is not available for this version.</p>;
  return <BpmnDiagram xml={d.xml} completed={ids.done} active={ids.active} incidents={ids.incidents} />;
}

export function InstanceDetail() {
  const { key = "" } = useParams();
  const q = useQuery({ queryKey: ["instance", key], queryFn: () => getJson<Detail>(`/api/instances/${key}`), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  return (
    <Loadable query={q} skeleton={<Skeleton rows={12} label="Loading the case" />} isEmpty={() => false}>
      {(d) => (
        <>
          <PageHeader
            title={`${PROCESS_NAMES[d.instance.processDefinitionId] ?? d.instance.processDefinitionName} ${d.instance.processInstanceKey}`}
            lead={
              <>
                Started {when(d.instance.startDate)}
                {d.instance.endDate ? `, finished ${when(d.instance.endDate)}` : ", still running"}. <Link to="/instances">All cases</Link>
              </>
            }
          />
          <Reveal>
            <Path d={d} />
            <p className="legend">
              <Tag kind="policy">done</Tag> <Tag kind="waiting">waiting here</Tag> <Tag kind="incident">stopped</Tag>
            </p>
          </Reveal>
          <div className="two">
            <Reveal delay={0.15}>
              <h2>Audit trail</h2>
              {d.audit.length ? <AuditList items={d.audit} /> : <EmptyState title="No audit entries for this case" />}
            </Reveal>
            <Reveal delay={0.2}>
              <h2>Variables</h2>
              <p className="footnote">E-mail addresses, messages and approval tokens are hidden.</p>
              <pre className="vars">{JSON.stringify(d.variables, null, 2)}</pre>
            </Reveal>
          </div>
        </>
      )}
    </Loadable>
  );
}
