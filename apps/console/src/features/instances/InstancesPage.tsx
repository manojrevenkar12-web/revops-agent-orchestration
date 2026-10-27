import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { getJson, type InstanceSummary } from "../../shared/api/client";
import { layout } from "../../shared/theme/theme";
import { EmptyState, Loadable, Skeleton } from "../../shared/ui/states";
import { PageHeader, PROCESS_NAMES, Tag, when } from "../../shared/ui/ui";

export function InstancesPage() {
  const [params, setParams] = useSearchParams();
  const process = params.get("process") ?? "";
  const state = params.get("state") ?? "";
  const q = useQuery({
    queryKey: ["instances", process, state],
    queryFn: () => getJson<{ items: InstanceSummary[] }>(`/api/instances?limit=${layout.pageSize}${process ? `&process=${process}` : ""}${state ? `&state=${state}` : ""}`),
    refetchInterval: layout.refreshMs,
  });
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n);
  };
  return (
    <>
      <PageHeader title="Cases" lead="Each case is one process instance in Camunda. Open one to see the path it took and every decision in its audit trail." />
      <div className="filters">
        <label>
          Automation
          <select value={process} onChange={(e) => set("process", e.target.value)}>
            <option value="">All</option>
            {Object.entries(PROCESS_NAMES).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          State
          <select value={state} onChange={(e) => set("state", e.target.value)}>
            <option value="">All</option>
            <option value="ACTIVE">Running</option>
            <option value="COMPLETED">Finished</option>
          </select>
        </label>
      </div>
      <Loadable
        query={q}
        skeleton={<Skeleton rows={10} label="Loading cases" />}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState title="No cases match">Change the filters, or wait for the next form, scan or registration.</EmptyState>}
      >
        {(d) => (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Automation</th>
                <th scope="col">Started</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.processInstanceKey}>
                  <td>
                    <Link to={`/instances/${i.processInstanceKey}`} className="num">
                      {i.processInstanceKey}
                    </Link>
                  </td>
                  <td>{PROCESS_NAMES[i.processDefinitionId] ?? i.processDefinitionName}</td>
                  <td className="num">{when(i.startDate)}</td>
                  <td>{i.hasIncident ? <Tag kind="incident">incident</Tag> : i.state === "ACTIVE" ? <Tag kind="waiting">running</Tag> : <Tag kind="none">finished</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Loadable>
    </>
  );
}
