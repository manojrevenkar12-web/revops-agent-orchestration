import { BigQuery } from "@google-cloud/bigquery";
import jsforce, { type Connection } from "jsforce";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KEYS, type Sandbox, buildSandbox } from "./server";
import { SoqlError, parseSoql } from "./soql";

let sb: Sandbox;
let base: string;

beforeAll(async () => {
  sb = buildSandbox();
  await sb.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = sb.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await sb.app.close();
});

async function sfConn(): Promise<Connection> {
  const tok = await fetch(`${base}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: DEFAULT_KEYS.sfClientId, client_secret: DEFAULT_KEYS.sfClientSecret }),
  }).then((r) => r.json() as Promise<{ access_token: string; instance_url: string }>);
  return new jsforce.Connection({ instanceUrl: tok.instance_url, accessToken: tok.access_token, version: "62.0" });
}

describe("SOQL subset", () => {
  it("parses the queries an integration sends and rejects malformed ones", () => {
    const q = parseSoql(
      "SELECT Id, Account.Name FROM Opportunity WHERE (StageName = 'Proposal' OR Amount >= 50000) AND CloseDate = NEXT_N_DAYS:90 AND Type NOT IN ('Renewal') ORDER BY CloseDate DESC NULLS LAST LIMIT 10",
    );
    expect(q.object).toBe("Opportunity");
    expect(q.fields).toEqual(["Id", "Account.Name"]);
    expect(q.limit).toBe(10);
    expect(() => parseSoql("SELECT FROM Account")).toThrow(SoqlError);
    expect(() => parseSoql("SELECT Id FROM Account WHERE Name = 'unterminated")).toThrow(SoqlError);
  });
});

describe("Salesforce emulator through jsforce", () => {
  it("queries with relationship fields, date literals and paging", async () => {
    const conn = await sfConn();
    const res = await conn.query<{ Id: string; Account: { Name: string }; CloseDate: string }>(
      "SELECT Id, Account.Name, CloseDate FROM Opportunity WHERE Type = 'Renewal' AND CloseDate = NEXT_N_DAYS:120 ORDER BY CloseDate",
    );
    expect(res.totalSize).toBeGreaterThan(5);
    expect(res.records[0]?.Account.Name).toBeTruthy();
    const all = await conn.query("SELECT Id FROM Contact", { autoFetch: true, maxFetch: 5000 });
    expect(all.records.length).toBe(sb.world.contacts.length);
  });

  it("upserts by external id idempotently and reports invalid fields like Salesforce", async () => {
    const conn = await sfConn();
    const a = await conn.sobject("Lead").upsert({ HubSpot_Submission_Id__c: "hs-test-1", LastName: "Okafor", Company: "Test GmbH", Status: "Open" } as never, "HubSpot_Submission_Id__c");
    const b = await conn.sobject("Lead").upsert({ HubSpot_Submission_Id__c: "hs-test-1", LastName: "Okafor", Company: "Test GmbH", Status: "Working" } as never, "HubSpot_Submission_Id__c");
    expect((a as unknown as { created: boolean }).created).toBe(true);
    expect((b as unknown as { created: boolean }).created).toBe(false);
    await expect(conn.query("SELECT Id, NoSuchField__c FROM Lead")).rejects.toThrow(/INVALID_FIELD|No such column/);
  });

  it("runs Bulk API 2.0 queries with CSV results", async () => {
    const conn = await sfConn();
    const records = await conn.bulk2.query("SELECT Id, Email FROM Contact WHERE Champion__c = true");
    const rows = await records.toArray();
    expect(rows.length).toBe(sb.world.accounts.length);
  });

  it("enforces the daily API limit and reports usage", async () => {
    sb.org.apiUsed = sb.org.dailyMax;
    const conn = await sfConn();
    await expect(conn.query("SELECT Id FROM Account LIMIT 1")).rejects.toThrow(/REQUEST_LIMIT_EXCEEDED|TotalRequests/);
    sb.org.apiUsed = 0;
  });

  it("keeps change events for 72 hours and refuses an expired replay id", async () => {
    const opp = sb.world.opportunities[0]!;
    const sub = (body: object) =>
      fetch(`${base}/pubsub/subscribe`, {
        method: "POST",
        headers: { authorization: "Bearer 00DSb000000sandbox!sandbox-access-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<{ events: Array<{ replayId: string }>; latestReplayId: string }> & Promise<unknown>);
    sb.org.update("Opportunity", opp.Id, { StageName: "Negotiation" });
    const first = (await sub({ topicName: "/data/OpportunityChangeEvent", replayPreset: "EARLIEST" })) as { events: Array<{ replayId: string }> };
    expect(first.events.length).toBeGreaterThan(0);
    const replayId = first.events.at(-1)!.replayId;
    sb.clock.advance(73 * 3600 * 1000);
    const expired = (await sub({ topicName: "/data/OpportunityChangeEvent", replayPreset: "CUSTOM", replayId })) as unknown as Array<{ errorCode: string }>;
    expect(expired[0]?.errorCode).toBe("REPLAY_ID_NOT_AVAILABLE");
  });
});

describe("BigQuery emulator through the official client", () => {
  it("runs a parameterised query", async () => {
    const bq = new BigQuery({ projectId: "revops-sandbox", apiEndpoint: base });
    const accountId = sb.world.usage[0]!.account_id;
    const [rows] = await bq.query({
      query: "SELECT week_start, active_process_instances FROM `revops-sandbox.product.product_usage_weekly` WHERE account_id = @account ORDER BY week_start",
      params: { account: accountId },
    });
    expect(rows).toHaveLength(12);
  });
});

describe("truth isolation", () => {
  it("serves the truth only with the evaluation token", async () => {
    expect((await fetch(`${base}/_sandbox/truth`)).status).toBe(403);
    expect((await fetch(`${base}/_sandbox/truth`, { headers: { authorization: `Bearer ${DEFAULT_KEYS.truthToken}` } })).status).toBe(200);
  });
});
