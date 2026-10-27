import type { AuditEntry } from "../../shared/api/client";
import type { Kind } from "../../shared/theme/theme";
import { Tag, when } from "../../shared/ui/ui";

const kindOf = (e: AuditEntry): Kind => {
  if (e.outcome === "error") return "incident";
  if (e.outcome === "denied") return "waiting";
  const by = String(e.detail.approvedBy ?? e.detail.by ?? "");
  if (by.startsWith("slack:")) return "person";
  if (by.startsWith("policy:")) return "policy";
  return "none";
};

const describe = (e: AuditEntry): string => {
  const d = e.detail;
  switch (e.action) {
    case "approval.issued":
      return `approval for ${(d.tools as string[] | undefined)?.join(", ") ?? "changes"} by ${String(d.approvedBy)}`;
    case "approval.decided":
      return `${String(d.outcome)} by ${String(d.by)}`;
    case "approval.requested":
      return `asked in Slack (${String(d.kind)})`;
    case "tool.call":
      return `${e.subject.replace("tool/", "")}${d.replay ? " (repeat, first result returned)" : ""}${d.reason ? `: ${String(d.reason)}` : ""}`;
    case "model.call":
      return `${String(d.task)}${d.intent ? `: ${String(d.intent)}` : ""}`;
    case "agent.turn":
      return `agent ${String(d.action)}${(d.tools as string[] | undefined)?.length ? `: ${(d.tools as string[]).join(", ")}` : ""}`;
    case "brief.verified":
      return d.grounded ? "brief matches the facts" : `brief has ${String(d.unsupported)} unsupported claim(s)`;
    default:
      return e.action;
  }
};

export function AuditList({ items }: { items: AuditEntry[] }) {
  return (
    <ol className="audit">
      {items.map((e) => (
        <li key={e.seq}>
          <span className="num audit-time">{when(e.at)}</span>
          <Tag kind={kindOf(e)}>{e.actor.replace(/^worker:/, "")}</Tag>
          <span>{describe(e)}</span>
        </li>
      ))}
    </ol>
  );
}
