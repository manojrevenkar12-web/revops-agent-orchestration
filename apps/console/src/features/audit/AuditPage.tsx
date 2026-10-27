import { useQuery } from "@tanstack/react-query";
import { type AuditEntry, getJson } from "../../shared/api/client";
import { layout } from "../../shared/theme/theme";
import { EmptyState, Loadable, Skeleton } from "../../shared/ui/states";
import { PageHeader, Tag } from "../../shared/ui/ui";
import { AuditList } from "./AuditList";

export function AuditPage() {
  const q = useQuery({
    queryKey: ["audit"],
    queryFn: () => getJson<{ verified: { intact: boolean; entries: number; brokenAt?: number }; items: AuditEntry[] }>("/api/audit?limit=300"),
    refetchInterval: layout.refreshMs,
  });
  return (
    <>
      <PageHeader title="Audit log" lead="Every tool call, approval and model call, newest first. Each entry includes the hash of the one before it, so an edited or removed entry breaks the chain." />
      <Loadable
        query={q}
        skeleton={<Skeleton rows={12} label="Loading the audit log" />}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState title="The log is empty">Entries appear with the first webhook, tool call or approval.</EmptyState>}
      >
        {(d) => (
          <>
            <p className="chain">
              {d.verified.intact ? <Tag kind="policy">chain intact</Tag> : <Tag kind="incident">chain broken at entry {d.verified.brokenAt}</Tag>}{" "}
              <span className="num">{d.verified.entries} entries</span>
            </p>
            <AuditList items={d.items} />
          </>
        )}
      </Loadable>
    </>
  );
}
