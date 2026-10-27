/**
 * Slack: approval requests as Block Kit messages, notifications, and the record of every approval.
 *
 * An approval message shows exactly what will be written (the proposal), and its hash is stored with the request.
 * When the person approves, the approval token is issued only if the changes about to be written still hash to
 * what they saw. Message metadata (event_type revops_approval) lets other tools find open approvals.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, sha256 } from "@revops/core";

type Json = Record<string, unknown>;
type Block = Record<string, unknown>;

export interface ApprovalRecord {
  approvalId: string;
  kind: "lead" | "renewal" | "deal_registration";
  processInstanceKey: string;
  elementInstanceKey: string;
  subjectId: string;
  channel: string;
  ts: string;
  proposal: Json;
  proposalHash: string;
  createdAt: string;
  decidedAt?: string;
  decision?: { outcome: string; by: string; edits?: Json | null };
  override?: boolean;
  closedAt?: string;
  closedAs?: string;
}

export interface ApprovalStore {
  get(id: string): ApprovalRecord | undefined;
  put(r: ApprovalRecord): void;
  list(filter?: (r: ApprovalRecord) => boolean): ApprovalRecord[];
}

/** File-backed for local runs (one JSON line per change, last one wins); production keeps the same records in Firestore. */
export class FileApprovalStore implements ApprovalStore {
  private map = new Map<string, ApprovalRecord>();
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) for (const l of readFileSync(path, "utf8").split("\n").filter(Boolean)) this.map.set((JSON.parse(l) as ApprovalRecord).approvalId, JSON.parse(l));
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, "");
    }
  }
  get(id: string) {
    return this.map.get(id);
  }
  put(r: ApprovalRecord) {
    this.map.set(r.approvalId, r);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(r)}\n`);
  }
  list(filter: (r: ApprovalRecord) => boolean = () => true) {
    return [...this.map.values()].filter(filter);
  }
}

export const proposalHash = (writes: unknown) => sha256(canonical(writes ?? null));

const mrkdwn = (text: string) => ({ type: "mrkdwn", text: text.slice(0, 2900) });
const plain = (text: string) => ({ type: "plain_text", text: text.slice(0, 150), emoji: false });
const section = (text: string, fields?: string[]): Block => ({ type: "section", text: mrkdwn(text), ...(fields?.length ? { fields: fields.slice(0, 10).map(mrkdwn) } : {}) });
const context = (text: string): Block => ({ type: "context", elements: [mrkdwn(text)] });
const button = (action: string, label: string, value: Json, style?: "primary" | "danger", confirm?: string): Block => ({
  type: "button",
  action_id: action,
  text: plain(label),
  value: JSON.stringify(value),
  ...(style ? { style } : {}),
  ...(confirm ? { confirm: { title: plain("Are you sure?"), text: mrkdwn(confirm), confirm: plain("Yes"), deny: plain("Cancel") } } : {}),
});
/** Slack mrkdwn escaping: user text must not be able to mention @channel or forge links. */
export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const pct = (p: unknown) => (typeof p === "number" ? `${Math.round(p * 100)} %` : "n/a");

const INTENTS = ["demo_request", "pricing", "expansion", "support_issue", "partnership", "job_application", "spam"];

export function leadApproval(approvalId: string, v: Json): { text: string; blocks: Block[]; proposal: Json } {
  const lead = (v.lead ?? {}) as Json;
  const c = (v.classification ?? {}) as Json;
  const r = (v.routing ?? {}) as Json;
  const plan = (v.plan ?? {}) as Json;
  const sub = (v.submission ?? {}) as Json;
  const reasons = (v.reviewReasons ?? []) as string[];
  const text = `Inbound request from ${lead.company}: suggested ${c.intent}`;
  const blocks: Block[] = [
    { type: "header", text: plain(`Inbound request: ${lead.company ?? "unknown company"}`) },
    section(`*Suggested:* ${esc(c.intent)} (${pct(c.confidence)} calibrated)  ·  *Route to:* ${esc(r.queue ?? "-")}  ·  *Owner:* ${esc(plan.ownerName ?? "-")}`, [
      `*Segment*\n${esc(lead.segment)}`,
      `*Region*\n${esc(lead.region)}`,
      `*Existing customer*\n${lead.isCustomer ? "yes" : "no"}`,
      `*Cadence*\n${esc(r.cadenceKey ?? "none")}`,
    ]),
    section(`*Message*\n>${esc(String(sub.message ?? "").slice(0, 600)).replace(/\n/g, "\n>")}`),
    context(
      `Why you are asked: ${reasons.map(esc).join("; ") || "policy"}${c.injectionSuspected ? "  ·  :warning: the message contains text that tries to instruct the system" : ""}  ·  decide within ${r.slaMinutes ?? 60} minutes`,
    ),
    {
      type: "actions",
      block_id: "decision",
      elements: [
        button("approve", "Route as suggested", { approvalId }, "primary"),
        {
          type: "static_select",
          action_id: "edit",
          placeholder: plain("Different intent"),
          options: INTENTS.filter((i) => i !== c.intent).map((i) => ({ text: plain(i.replace("_", " ")), value: JSON.stringify({ approvalId, intent: i }) })),
        },
        button("reject", "Discard", { approvalId }, "danger", "The request is closed without a lead."),
      ],
    },
  ];
  return { text, blocks, proposal: { intent: c.intent, queue: r.queue, ownerId: plan.ownerId, writes: plan.writes } };
}

export function renewalApproval(approvalId: string, v: Json): { text: string; blocks: Block[]; proposal: Json } {
  const brief = (v.brief ?? {}) as { summary?: string; claims?: Array<{ text: string; cites: string[] }>; recommendedPlay?: { title: string; passageId: string } | null };
  const ver = (v.verification ?? {}) as Json;
  const plan = (v.plan ?? {}) as { accountName?: string; writes?: Json; summary?: string };
  const claims = (brief.claims ?? []).map((c) => `• ${esc(c.text)} _(${c.cites.map(esc).join(", ")})_`).join("\n");
  const text = `Renewal at risk: ${plan.accountName}`;
  const blocks: Block[] = [
    { type: "header", text: plain(`Renewal at risk: ${plan.accountName ?? v.opportunityId}`) },
    section(`*Risk:* ${pct(ver.riskProbability)} (calibrated)  ·  *Brief checked:* every claim matches a fact\n${esc(brief.summary)}`),
    section(`*What the brief relies on*\n${claims}`),
    section(`*Proposed save play:* ${esc(brief.recommendedPlay?.title ?? "none")}\n${esc(plan.summary ?? "")}`),
    {
      type: "actions",
      block_id: "decision",
      elements: [
        button("approve", "Start the save play", { approvalId }, "primary"),
        button("reject", "Not now", { approvalId }, undefined, "No CTA or task is created. Your answer is recorded and used to tune the threshold."),
      ],
    },
  ];
  return { text, blocks, proposal: { writes: plan.writes } };
}

export function dealRegistrationApproval(approvalId: string, v: Json): { text: string; blocks: Block[]; proposal: Json } {
  const reg = (v.registration ?? {}) as Json;
  const pd = (v.policyDecision ?? {}) as Json;
  const conflict = (v.conflict ?? {}) as Json;
  const draft = (v.draft ?? {}) as Json;
  const suggestion = String(pd.suggestion ?? "approve");
  const other = suggestion === "approve" ? "reject" : "approve";
  const text = `Deal registration ${reg.id}: ${reg.companyName} (${pd.reasonCode})`;
  const blocks: Block[] = [
    { type: "header", text: plain(`Deal registration ${reg.id}: ${reg.companyName}`) },
    section(`*Policy:* ${esc(pd.reasonCode)}  ·  *Suggested:* ${suggestion}  ·  *Amount:* ${esc(reg.amount)} EUR`, [
      `*Conflict*\n${esc(conflict.kind)}`,
      `*Domain*\n${esc(reg.domain)}`,
      `*Product*\n${esc(reg.product)}`,
      `*Expected close*\n${esc(reg.expectedCloseDate)}`,
    ]),
    section(`*Message the partner will receive*\n>${esc(draft.partnerMessage)}`),
    {
      type: "actions",
      block_id: "decision",
      elements: [
        button("approve", suggestion === "approve" ? "Approve registration" : "Reject registration", { approvalId }, "primary"),
        button("edit", other === "approve" ? "Approve instead" : "Reject instead", { approvalId, decision: other }),
        button("reject", "I will handle it", { approvalId }),
      ],
    },
  ];
  return { text, blocks, proposal: { decision: suggestion, reasonCode: pd.reasonCode } };
}

export function decidedBlocks(original: string, outcome: string, by: string): Block[] {
  return [
    section(original),
    context(`${outcome === "approve" ? ":white_check_mark: Approved" : outcome === "edit" ? ":pencil2: Changed" : outcome === "expired" ? ":hourglass: Expired" : ":x: Declined"} by ${esc(by)}`),
  ];
}

/** Notifications. Each template names the facts it relies on; nothing here asks for a decision. */
export function notification(template: string, v: Json): { text: string; blocks: Block[] } {
  const lead = (v.lead ?? {}) as Json;
  const r = (v.routing ?? {}) as Json;
  const c = (v.classification ?? {}) as Json;
  const plan = (v.plan ?? {}) as Json;
  const reg = (v.registration ?? {}) as Json;
  const text = (() => {
    switch (template) {
      case "lead_sla":
        return `:alarm_clock: Speed-to-lead target of ${r.slaMinutes} minutes reached for ${esc(lead.company)} (${esc(c.intent)}). The request is still waiting in #adr-inbound.`;
      case "lead_forward":
        return `Request from ${esc(lead.company)} classified as ${esc(c.intent)} (${pct(c.confidence)}): ${esc(String(((v.submission ?? {}) as Json).message ?? "").slice(0, 400))}`;
      case "lead_assigned":
        return `You have a new ${esc(c.intent)} lead: ${esc(lead.firstName)} ${esc(lead.lastName)} at ${esc(lead.company)} (${esc(lead.segment)}, ${esc(lead.region)}). Follow-up task due today${plan.writes && (plan.writes as Json).enroll ? `; enrolled in ${esc(r.cadenceKey)}` : ""}.`;
      case "renewal_no_brief":
        return `The renewal investigation for opportunity ${esc(v.opportunityId)} stopped without a brief (time budget or model limit). The account facts are in the console; please review the renewal directly.`;
      case "renewal_unverified": {
        const ver = (v.verification ?? {}) as { unsupported?: Array<{ claim: string; reason: string }> };
        return `The brief for opportunity ${esc(v.opportunityId)} contained claims that do not match the facts, so no save play is proposed: ${(ver.unsupported ?? []).map((u) => `"${esc(u.claim)}" (${esc(u.reason)})`).join("; ")}. Please review the renewal directly.`;
      }
      case "renewal_escalation":
        return `:rotating_light: A save play for ${esc(plan.accountName ?? v.opportunityId)} has waited for a CSM decision for a day. You can decide on the original message in #cs-renewals.`;
      case "dealreg_reminder":
        return `Reminder: deal registration ${esc(reg.id)} for ${esc(reg.companyName)} is waiting for a decision. The partner was promised an answer within two business days.`;
      case "dealreg_escalation":
        return `:rotating_light: Deal registration ${esc(reg.id)} for ${esc(reg.companyName)} passed the response deadline promised to the partner without a decision.`;
      case "dealreg_decided":
        return `Deal registration ${esc(reg.id)} for ${esc(reg.companyName)}: ${esc(v.finalDecision)} (${esc(((v.decision ?? {}) as Json).by)}).`;
      default:
        return `${template}: ${esc(JSON.stringify(v).slice(0, 300))}`;
    }
  })();
  return { text: text.replace(/<[^>]+>/g, ""), blocks: [section(text)] };
}
