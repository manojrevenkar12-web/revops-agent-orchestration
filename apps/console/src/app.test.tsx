import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const overview = {
  generatedAt: "2026-10-27T10:00:00Z",
  lanes: [
    {
      id: "inbound-lead-routing",
      title: "Inbound leads",
      total: 10,
      segments: [
        { kind: "policy", label: "Routed by policy", count: 6 },
        { kind: "person", label: "Decided by an ADR", count: 3 },
        { kind: "waiting", label: "Waiting for an ADR", count: 1 },
      ],
    },
  ],
  processes: [],
  leads: { received: 10, autoRouted: 6, personDecided: 3, overrides: 1, overrideRate: 0.333 },
  renewals: { investigated: 4, grounded: 4, ungrounded: 0, proposed: 2, approved: 1, declined: 1 },
  registrations: { autoApproved: 2, reviewed: 1 },
  approvals: { open: 1, decided: 3, overrideRate: 0.333, medianMinutesToDecision: 4 },
  hoursSaved: 1.2,
  models: { calls: 12, inputTokens: 9000, outputTokens: 1000, costUsd: null, costKnown: false, repairs: 1, latencyMs: { p50: 10, p95: 40 }, unavailable: 0 },
  incidents: 0,
};

function serve(routes: Record<string, () => Response | Promise<Response>>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([p]) => url.startsWith(p));
    if (!hit) return new Response("{}", { status: 404 });
    return hit[1]();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const at = (path: string) => window.history.pushState({}, "", path);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("overview", () => {
  it("shows a skeleton, then each automation as a lane split by who decided", async () => {
    let release: (r: Response) => void = () => undefined;
    serve({
      "/api/overview": () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    });
    at("/");
    render(<App client={client()} />);
    expect(screen.getByRole("status", { name: "Loading the overview" })).toBeInTheDocument();
    release(json(overview));
    expect(await screen.findByRole("img", { name: /Inbound leads: 6 routed by policy, 3 decided by an adr, 1 waiting for an adr/ })).toBeInTheDocument();
    expect(screen.getByText("33.3 % of 3 decisions")).toBeInTheDocument();
    expect(screen.getByText(/not priced/)).toBeInTheDocument();
  });

  it("explains a failure and retries on request", async () => {
    let calls = 0;
    serve({ "/api/overview": () => (++calls === 1 ? json({}, 502) : json(overview)) });
    at("/");
    render(<App client={client()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The orchestrator answered 502.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Inbound leads" })).toBeInTheDocument();
  });

  it("says what will fill an empty overview", async () => {
    serve({ "/api/overview": () => json({ ...overview, lanes: [{ ...overview.lanes[0], total: 0, segments: [] }] }) });
    at("/");
    render(<App client={client()} />);
    expect(await screen.findByText("No cases yet")).toBeInTheDocument();
  });
});

describe("decisions in Slack", () => {
  it("lists waiting requests and switches to decided ones", async () => {
    const f = serve({
      "/api/approvals?state=open": () =>
        json({
          items: [
            {
              approvalId: "apv-1",
              kind: "lead",
              processInstanceKey: "225",
              subjectId: "hs-100001",
              channel: "#adr-inbound",
              proposal: { intent: "pricing", queue: "EMEA Commercial" },
              createdAt: "2026-10-27T09:00:00Z",
            },
          ],
        }),
      "/api/approvals?state=decided": () => json({ items: [] }),
    });
    at("/approvals");
    render(<App client={client()} />);
    expect(await screen.findByText("pricing → EMEA Commercial")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Decided" }));
    expect(await screen.findByText("No decisions yet")).toBeInTheDocument();
    expect(f).toHaveBeenCalledWith("/api/approvals?state=decided", expect.anything());
  });
});

describe("a case", () => {
  it("says when a case does not exist", async () => {
    serve({ "/api/instances/999": () => json({ error: "not found" }, 404) });
    at("/instances/999");
    render(<App client={client()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not found."));
  });

  it("shows the audit trail with who approved each change", async () => {
    serve({
      "/api/instances/225": () =>
        json({
          instance: {
            processInstanceKey: "225",
            processDefinitionId: "inbound-lead-routing",
            processDefinitionName: "Inbound lead routing",
            startDate: "2026-10-27T09:00:00Z",
            endDate: null,
            state: "ACTIVE",
            hasIncident: false,
          },
          elements: [],
          xml: null,
          variables: { routing: { queue: "EMEA Commercial" } },
          audit: [
            {
              seq: 1,
              at: "2026-10-27T09:01:00Z",
              actor: "worker:approval.issue",
              action: "approval.issued",
              subject: "process/225",
              outcome: "ok",
              detail: { approvedBy: "slack:U123", tools: ["crm_upsert_lead"] },
              hash: "x",
            },
          ],
        }),
    });
    at("/instances/225");
    render(<App client={client()} />);
    expect(await screen.findByText("approval for crm_upsert_lead by slack:U123")).toBeInTheDocument();
    expect(screen.getByText(/EMEA Commercial/)).toBeInTheDocument();
  });
});
