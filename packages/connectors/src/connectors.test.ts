import { startSandbox } from "@revops/sandbox";
import { hubspotSignatureV3, slackSignature } from "@revops/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChangeEvent, ChangeSubscriber, HttpPubSubTransport, MemoryReplayStore } from "./cdc";
import { type Connectors, buildConnectors } from "./factory";
import { verifyHubspotV3, verifySlack } from "./gtm";
import { BudgetExhausted, soqlQuote } from "./salesforce";

let sb: Awaited<ReturnType<typeof startSandbox>>;
let c: Connectors;
const noSleep = async () => undefined;

beforeAll(async () => {
  sb = await startSandbox();
  c = buildConnectors({ baseUrl: sb.url, sleep: noSleep });
});
afterAll(() => sb.close());

describe("Salesforce client", () => {
  it("pages through query results and quotes values safely", async () => {
    const rows = await c.salesforce.query("SELECT Id, Email FROM Contact");
    expect(rows.length).toBe(sb.world.contacts.length);
    const evil = "x' OR Name != '";
    const none = await c.salesforce.query(`SELECT Id FROM Account WHERE Name = ${soqlQuote(evil)}`);
    expect(none).toHaveLength(0);
  });

  it("retries transient lock errors and does not retry validation errors", async () => {
    sb.org.faults = { lockRowEvery: 2, unavailableEvery: 0 };
    const r = await c.salesforce.upsert("Task", "External_Key__c", "k-1", { Subject: "Follow up", Status: "Open" });
    expect(r.id).toBeTruthy();
    sb.org.faults = { lockRowEvery: 0, unavailableEvery: 0 };
    await expect(c.salesforce.upsert("Task", "External_Key__c", "k-2", { NoSuchField__c: 1 })).rejects.toThrow(/INVALID_FIELD/);
  });

  it("keeps a reserve of the daily API allowance: background work stops first", async () => {
    sb.org.apiUsed = Math.floor(sb.org.dailyMax * 0.85);
    await c.salesforce.limits();
    await expect(c.salesforce.query("SELECT Id FROM Account LIMIT 1", { priority: "background" })).rejects.toBeInstanceOf(BudgetExhausted);
    const ok = await c.salesforce.query("SELECT Id FROM Account LIMIT 1", { priority: "interactive" });
    expect(ok).toHaveLength(1);
    sb.org.apiUsed = 0;
    await c.salesforce.limits();
  });

  it("reads large sets through Bulk API 2.0", async () => {
    const rows = await c.salesforce.bulkQuery("SELECT Id, AccountId FROM Contact");
    expect(rows.length).toBe(sb.world.contacts.length);
  });
});

describe("change data capture", () => {
  it("resumes from the stored replay id and recovers after a gap longer than the retention", async () => {
    const store = new MemoryReplayStore();
    const sub = new ChangeSubscriber(new HttpPubSubTransport(c.salesforce), store, c.salesforce, {
      "/data/OpportunityChangeEvent": { object: "Opportunity", fields: ["CloseDate", "StageName"] },
    });
    const seen: ChangeEvent[] = [];
    const handle = async (e: ChangeEvent) => {
      seen.push(e);
    };
    await sub.poll("/data/OpportunityChangeEvent", handle); // takes the current position
    const opp = sb.world.opportunities.find((o) => o.Type === "Renewal")!;
    sb.org.update("Opportunity", opp.Id, { StageName: "Negotiation" });
    await sub.poll("/data/OpportunityChangeEvent", handle);
    expect(seen.map((e) => e.payload.ChangeEventHeader.recordIds[0])).toContain(opp.Id);
    // down for four days: the stored replay id has expired
    sb.org.update("Opportunity", opp.Id, { StageName: "Proposal" });
    sb.clock.advance(4 * 24 * 3600 * 1000);
    sb.org.update("Opportunity", opp.Id, { CloseDate: "2027-03-01" });
    seen.length = 0;
    const res = await sub.poll("/data/OpportunityChangeEvent", handle);
    expect(res.resynced).toBeGreaterThan(0);
    expect(seen.every((e) => e.resync)).toBe(true);
    expect(seen.some((e) => e.payload.ChangeEventHeader.recordIds[0] === opp.Id)).toBe(true);
  });
});

describe("GTM systems", () => {
  it("creates a Gainsight CTA once per reference id", async () => {
    const owner = sb.world.users.find((u) => u.Role === "CSM")!;
    const acc = sb.world.accounts.find((a) => a.Type === "Customer")!;
    const cta = {
      referenceId: "renewal-risk:abc",
      name: "Renewal at risk",
      typeName: "Risk",
      priority: "High",
      reason: "Usage decline",
      companySfdcId: acc.Id,
      ownerEmail: owner.Email,
      dueDate: "2026-11-02",
      comments: "brief",
    };
    const a = await c.gainsight.createCta(cta);
    const b = await c.gainsight.createCta(cta);
    expect(a.gsid).toBe(b.gsid);
    expect(b.created).toBe(false);
    expect(sb.gtm.ctas).toHaveLength(1);
  });

  it("enrolls in a Salesloft cadence idempotently", async () => {
    const id = await c.salesloft.findOrCreatePerson({ email: "lena.weber@nordwerk.example", firstName: "Lena", lastName: "Weber", title: "CTO", company: "Nordwerk" });
    expect(await c.salesloft.findOrCreatePerson({ email: "lena.weber@nordwerk.example", firstName: "Lena", lastName: "Weber", title: "CTO", company: "Nordwerk" })).toBe(id);
    const first = await c.salesloft.enroll(id, "cad-emea-demo");
    const again = await c.salesloft.enroll(id, "cad-emea-demo");
    expect(first.alreadyEnrolled).toBe(false);
    expect(again.alreadyEnrolled).toBe(true);
  });

  it("reads usage from BigQuery with named parameters", async () => {
    const acc = sb.world.usage[0]!.account_id;
    const rows = await c.warehouse.run<{ week_start: string; active_users: number }>("usage_trend", { account_id: acc });
    expect(rows).toHaveLength(12);
  });
});

describe("webhook signatures", () => {
  it("accepts HubSpot v3 signatures and refuses tampering and replays", () => {
    const now = Date.now();
    const body = '[{"objectId":"hs-1"}]';
    const uri = "https://revops.example/webhooks/hubspot";
    const sig = hubspotSignatureV3("s3cret", "POST", uri, body, String(now));
    expect(verifyHubspotV3({ secret: "s3cret", method: "POST", uri, rawBody: body, signature: sig, timestamp: String(now), nowMs: now }).ok).toBe(true);
    expect(verifyHubspotV3({ secret: "s3cret", method: "POST", uri, rawBody: `${body} `, signature: sig, timestamp: String(now), nowMs: now }).ok).toBe(false);
    expect(verifyHubspotV3({ secret: "s3cret", method: "POST", uri, rawBody: body, signature: sig, timestamp: String(now), nowMs: now + 301_000 }).ok).toBe(false);
  });
  it("accepts Slack signatures within five minutes only", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature("sign", ts, "payload=x");
    expect(verifySlack({ signingSecret: "sign", rawBody: "payload=x", signature: sig, timestamp: ts, nowSec: Number(ts) }).ok).toBe(true);
    expect(verifySlack({ signingSecret: "sign", rawBody: "payload=y", signature: sig, timestamp: ts, nowSec: Number(ts) }).ok).toBe(false);
    expect(verifySlack({ signingSecret: "sign", rawBody: "payload=x", signature: sig, timestamp: ts, nowSec: Number(ts) + 400 }).ok).toBe(false);
  });
});
