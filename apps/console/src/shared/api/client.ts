/** The orchestrator's console API (read-only). Errors carry the status so screens can say what went wrong. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiError(0, "The console cannot reach the orchestrator.");
  }
  if (!res.ok) throw new ApiError(res.status, res.status === 404 ? "Not found." : `The orchestrator answered ${res.status}.`);
  return (await res.json()) as T;
}

export interface Lane {
  id: string;
  title: string;
  total: number;
  segments: Array<{ kind: "policy" | "person" | "none" | "waiting" | "incident"; label: string; count: number }>;
}

export interface Overview {
  generatedAt: string;
  lanes: Lane[];
  processes: Array<{ id: string; active: number; completed: number; incidents: number }>;
  leads: { received: number; autoRouted: number; personDecided: number; overrides: number; overrideRate: number | null };
  renewals: { investigated: number; grounded: number; ungrounded: number; proposed: number; approved: number; declined: number };
  registrations: { autoApproved: number; reviewed: number };
  approvals: { open: number; decided: number; overrideRate: number | null; medianMinutesToDecision: number | null };
  hoursSaved: number;
  models: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    costKnown: boolean;
    repairs: number;
    latencyMs: { p50: number | null; p95: number | null };
    unavailable: number;
  };
  incidents: number;
}

export interface Approval {
  approvalId: string;
  kind: "lead" | "renewal" | "deal_registration";
  processInstanceKey: string;
  subjectId: string;
  channel: string;
  proposal: Record<string, unknown>;
  createdAt: string;
  decidedAt?: string;
  decision?: { outcome: string; by: string; edits?: Record<string, unknown> | null };
  override?: boolean;
  closedAs?: string;
}

export interface InstanceSummary {
  processInstanceKey: string;
  processDefinitionId: string;
  processDefinitionName: string;
  startDate: string;
  endDate?: string | null;
  state: "ACTIVE" | "COMPLETED" | "TERMINATED";
  hasIncident: boolean;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  subject: string;
  outcome: "ok" | "denied" | "error" | "pending";
  detail: Record<string, unknown>;
  hash: string;
}

export interface InstanceDetail {
  instance: InstanceSummary;
  elements: Array<{ elementId: string; elementName: string; type: string; state: string; startDate: string; endDate: string | null; hasIncident: boolean }>;
  xml: string | null;
  variables: Record<string, unknown>;
  audit: AuditEntry[];
}

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
}
