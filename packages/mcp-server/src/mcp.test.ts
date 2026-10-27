import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildConnectors } from "@revops/connectors";
import { AuditLog } from "@revops/core";
import { startSandbox } from "@revops/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { argsHash, mintApproval, verifyApproval } from "./approval";
import { PlaybookIndex } from "./retrieval";
import { type GtmMcpService, buildMcpHttpService } from "./server";

let sb: Awaited<ReturnType<typeof startSandbox>>;
let svc: GtmMcpService;
let url: string;
const audit = new AuditLog();
const SECRET = "dev-approval-secret-change-me";

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as CallToolResult;
const approve = (tool: string, args: Record<string, unknown>, opts: { ttl?: number } = {}) =>
  mintApproval(SECRET, { tool, argsHash: argsHash(args), instance: "test-instance", approvedBy: "U0TEST (Slack)", ttlSeconds: opts.ttl ?? 3600, nowMs: sb.clock.now().getTime() });

beforeAll(async () => {
  sb = await startSandbox();
  svc = buildMcpHttpService({ connectors: buildConnectors({ baseUrl: sb.url, sleep: async () => undefined }), audit, clock: sb.clock });
  await new Promise<void>((r) => svc.http.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(svc.http.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  svc.http.close();
  await sb.close();
});

describe("approval tokens", () => {
  it("bind the tool and the exact arguments, and expire", () => {
    const args = { a: 1, b: "x" };
    const t = mintApproval(SECRET, { tool: "t", argsHash: argsHash(args), instance: "i", approvedBy: "me", ttlSeconds: 10, nowMs: 0 });
    expect(verifyApproval(SECRET, t, "t", { b: "x", a: 1, approval_token: t }, 1000).ok).toBe(true); // key order and the token itself do not matter
    expect(verifyApproval(SECRET, t, "other", args, 1000)).toMatchObject({ ok: false, reason: /not other/ });
    expect(verifyApproval(SECRET, t, "t", { a: 2, b: "x" }, 1000)).toMatchObject({ ok: false, reason: /differ/ });
    expect(verifyApproval(SECRET, t, "t", args, 11_000)).toMatchObject({ ok: false, reason: /expired/ });
    expect(verifyApproval("another-secret", t, "t", args, 1000)).toMatchObject({ ok: false, reason: /signature/ });
    const [v, body] = t.split(".");
    const forged = `${v}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body as string, "base64url").toString()), tool: "x" })).toString("base64url")}.${t.split(".")[2]}`;
    expect(verifyApproval(SECRET, forged, "x", args, 1000).ok).toBe(false);
  });
});

describe("playbook retrieval", () => {
  it("finds the passage that answers a question and gives it a stable id", () => {
    const idx = new PlaybookIndex();
    expect(idx.passages.length).toBeGreaterThan(10);
    const [top] = idx.search("champion left the company before renewal", 3);
    expect(top?.id).toMatch(/^renewal-save-plays#/);
    expect(idx.get(top?.id as string)?.text).toBeTruthy();
  });
});

describe("GTM MCP server over Streamable HTTP", () => {
  it("refuses callers without a known token", async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    await expect(connect("guessed-token")).rejects.toThrow();
  });

  it("refuses browser origins it does not know", async () => {
    const res = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", authorization: "Bearer analyst-dev-token", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });

  it("shows each caller only the tools its scopes allow", async () => {
    const analyst = await connect("analyst-dev-token");
    const orchestrator = await connect("orchestrator-dev-token");
    const a = (await analyst.listTools()).tools.map((t) => t.name);
    const o = (await orchestrator.listTools()).tools;
    expect(a).toContain("account_360");
    expect(a).not.toContain("crm_upsert_lead");
    expect(o.map((t) => t.name)).toContain("crm_upsert_lead");
    const lead = o.find((t) => t.name === "crm_upsert_lead");
    expect(lead?.annotations?.readOnlyHint).toBe(false);
    expect(lead?.inputSchema.properties).toHaveProperty("submission_id");
    expect(analyst.getInstructions()).toMatch(/approval_token/);
    await analyst.close();
    await orchestrator.close();
  });

  it("answers account_360 with citable facts from five systems", async () => {
    const renewal = sb.world.opportunities.find((o) => o.Type === "Renewal" && !o.IsClosed);
    const c = await connect("orchestrator-dev-token");
    const r = await call(c, "account_360", { account_id: renewal?.AccountId });
    expect(r.isError).toBeFalsy();
    const data = r.structuredContent as { facts: Array<{ id: string; source: string }>; renewalOpportunityId: string; contacts: Array<{ email: string }> };
    const ids = data.facts.map((f) => f.id);
    for (const id of ["account.arr", "renewal.days_to_close", "usage.process_instances_change_pct", "health.change_12w", "contacts.champion_left", "support.sev1_30d", "forecast.close_date_pushes"])
      expect(ids).toContain(id);
    expect(new Set(data.facts.map((f) => f.source.split(":")[0]))).toEqual(new Set(["salesforce", "bigquery", "gainsight", "clari"]));
    expect(data.renewalOpportunityId).toBe(renewal?.Id);
    expect(data.contacts[0]?.email).not.toMatch(/\*\*\*/); // orchestrator has gtm:pii
    await c.close();
  });

  it("masks personal data for a caller without gtm:pii", async () => {
    const acc = sb.world.contacts[0]?.AccountId as string;
    const c = await connect("analyst-dev-token");
    const r = await call(c, "account_360", { account_id: acc });
    const emails = (r.structuredContent as { contacts: Array<{ email: string }> }).contacts.map((x) => x.email);
    expect(emails.length).toBeGreaterThan(0);
    for (const e of emails) expect(e).toMatch(/^.\*\*\*@/);
    await c.close();
  });

  it("rejects invalid arguments, including SOQL-shaped ids, before touching Salesforce", async () => {
    const c = await connect("analyst-dev-token");
    const before = sb.org.apiUsed;
    const r = await call(c, "account_360", { account_id: "001' OR Name != '" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/invalid_arguments/);
    const extra = await call(c, "playbook_search", { query: "pricing", sneaky: true });
    expect(extra.isError).toBe(true);
    expect(sb.org.apiUsed).toBe(before);
    await c.close();
  });

  it("refuses a write tool to a read-only caller even if it knows the name", async () => {
    const c = await connect("analyst-dev-token");
    const r = await call(c, "crm_create_task", { external_key: "x-123456" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/forbidden/);
    await c.close();
  });

  it("writes only with an approval for exactly these arguments, once", async () => {
    const form = sb.world.forms[0];
    const owner = sb.world.users.find((u) => u.IsActive && u.Role === "AE");
    const args = {
      submission_id: form?.submissionId,
      first_name: "Ada",
      last_name: "Example",
      email: "ada@example.com",
      company: "Example GmbH",
      owner_id: owner?.Id,
      intent: "demo_request",
      queue: "DACH Enterprise",
    };
    const c = await connect("orchestrator-dev-token");

    const missing = await call(c, "crm_upsert_lead", args);
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/approval_required/);

    const token = approve("crm_upsert_lead", args);
    const changed = await call(c, "crm_upsert_lead", { ...args, owner_id: sb.world.users.find((u) => u.Id !== owner?.Id && u.IsActive)?.Id, approval_token: token });
    expect(JSON.stringify(changed.content)).toMatch(/arguments differ/);

    const other = await call(c, "crm_create_task", {
      external_key: "abc-123456",
      what_id: "001000000000000AAA",
      owner_id: owner?.Id,
      subject: "s",
      description: "d",
      due_date: "2026-11-01",
      approval_token: token,
    });
    expect(JSON.stringify(other.content)).toMatch(/approval is for crm_upsert_lead/);

    const leadsBefore = sb.org.tables.get("Lead")?.size ?? 0;
    const first = await call(c, "crm_upsert_lead", { ...args, approval_token: token });
    expect(first.isError).toBeFalsy();
    const firstData = first.structuredContent as { leadId: string; created: boolean };
    expect(firstData.created).toBe(true);
    const again = await call(c, "crm_upsert_lead", { ...args, approval_token: token });
    expect(again.structuredContent).toEqual(firstData); // replay returns the first result, nothing is written again
    expect(sb.org.tables.get("Lead")?.size).toBe(leadsBefore + 1);

    // A second, separately approved call for the same submission updates the same lead (external id), never duplicates.
    const second = await call(c, "crm_upsert_lead", { ...args, approval_token: approve("crm_upsert_lead", args) });
    expect(second.structuredContent as { leadId: string; created: boolean }).toEqual({ leadId: firstData.leadId, created: false });
    expect(sb.org.tables.get("Lead")?.size).toBe(leadsBefore + 1);

    const expired = approve("crm_upsert_lead", args, { ttl: -1 });
    expect(JSON.stringify((await call(c, "crm_upsert_lead", { ...args, approval_token: expired })).content)).toMatch(/expired/);
    await c.close();
  });

  it("creates a Gainsight CTA idempotently by reference id", async () => {
    const acc = sb.world.accounts.find((a) => a.Type === "Customer");
    const args = {
      reference_id: "renewal-risk-test-1",
      account_id: acc?.Id,
      owner_email: "csm@example.com",
      name: "Renewal at risk",
      reason: "Usage decline",
      priority: "High",
      due_date: "2026-11-02",
      comments: "Usage down; see facts usage.process_instances_change_pct",
    };
    const c = await connect("orchestrator-dev-token");
    const a = await call(c, "cs_create_cta", { ...args, approval_token: approve("cs_create_cta", args) });
    const b = await call(c, "cs_create_cta", { ...args, approval_token: approve("cs_create_cta", args) });
    expect((a.structuredContent as { created: boolean }).created).toBe(true);
    expect(b.structuredContent).toMatchObject({ gsid: (a.structuredContent as { gsid: string }).gsid, created: false });
    expect(sb.gtm.ctas.filter((x) => x.referenceId === "renewal-risk-test-1")).toHaveLength(1);
    await c.close();
  });

  it("serves the playbooks as resources and as search", async () => {
    const c = await connect("analyst-dev-token");
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain("playbook://renewal-save-plays");
    const doc = await c.readResource({ uri: "playbook://partner-programme" });
    expect(String((doc.contents[0] as { text: string }).text)).toMatch(/\[partner-programme#/);
    const hits = await call(c, "playbook_search", { query: "partner registered a deal where we already have an open opportunity" });
    expect((hits.structuredContent as { passages: Array<{ id: string }> }).passages[0]?.id).toMatch(/^partner-programme#/);
    await c.close();
  });

  it("audits every call, refused ones included, in a chain that verifies", () => {
    const entries = audit.list((e) => e.action === "tool.call", 1000);
    expect(entries.some((e) => e.outcome === "denied" && e.detail.reason === "approval_required")).toBe(true);
    expect(entries.some((e) => e.outcome === "denied" && String(e.detail.reason).includes("gtm:write"))).toBe(true);
    expect(entries.some((e) => e.outcome === "ok" && e.detail.replay === true)).toBe(true);
    const write = entries.find((e) => e.subject === "tool/crm_upsert_lead" && e.outcome === "ok" && !e.detail.replay);
    expect(write?.detail.approvedBy).toBe("U0TEST (Slack)");
    expect(JSON.stringify(entries)).not.toMatch(/ada@example\.com/); // arguments are hashed, never stored
    expect(audit.verify().intact).toBe(true);
  });
});
