/**
 * Connectors for the rest of the GTM stack. Each one is thin on purpose: authentication, the request shape of the
 * real API, the system's rate-limit and error behaviour, and nothing else. Business logic lives in processes and
 * workers, so swapping a system (Salesloft for Outreach, say) touches one file.
 */
import { createHmac } from "node:crypto";
import { BigQuery } from "@google-cloud/bigquery";
import { readRepoFile, safeEqual } from "@revops/core";
import { CircuitBreaker, type Sleep, UpstreamError, fetchJson, withRetry } from "./http";

type Json = Record<string, unknown>;

export class GainsightClient {
  readonly breaker = new CircuitBreaker("gainsight");
  constructor(
    private readonly baseUrl: string,
    private readonly accessKey: string,
    private readonly sleep?: Sleep,
  ) {}

  async healthHistory(sfdcAccountId: string, weeks = 12): Promise<Array<{ week: string; score: number }>> {
    const { data } = await withRetry(
      "gainsight",
      () =>
        fetchJson<{ result: boolean; data: { records: Array<{ WeekStart: string; Score: number }> } }>("gainsight", `${this.baseUrl}/v1/data/objects/query/HealthScoreHistory`, {
          method: "POST",
          headers: { accesskey: this.accessKey, "content-type": "application/json" },
          body: JSON.stringify({ select: ["SfdcAccountId", "WeekStart", "Score"], where: { conditions: [{ name: "SfdcAccountId", value: [sfdcAccountId], operator: "EQ" }] }, limit: 500 }),
        }),
      { breaker: this.breaker, sleep: this.sleep },
    );
    return data.data.records
      .map((r) => ({ week: r.WeekStart, score: r.Score }))
      .sort((a, b) => a.week.localeCompare(b.week))
      .slice(-weeks);
  }

  /** Creates one CTA. `referenceId` is our idempotency key: Gainsight refuses a second CTA with the same reference. */
  async createCta(cta: {
    referenceId: string;
    name: string;
    typeName: string;
    priority: string;
    reason: string;
    companySfdcId: string;
    ownerEmail: string;
    dueDate: string;
    comments: string;
  }): Promise<{ gsid: string; created: boolean }> {
    const { data } = await withRetry(
      "gainsight",
      () =>
        fetchJson<{ result: boolean; errorCode?: string; errorDesc?: string; message?: string | null; data: { success: Array<Record<string, string>>; failure: Array<Record<string, string>> } }>(
          "gainsight",
          `${this.baseUrl}/v2/cockpit/cta/`,
          {
            method: "POST",
            headers: { accesskey: this.accessKey, "content-type": "application/json" },
            body: JSON.stringify({
              requests: [
                {
                  referenceId: cta.referenceId,
                  Name: cta.name,
                  TypeName: cta.typeName,
                  PriorityName: cta.priority,
                  ReasonName: cta.reason,
                  DueDate: cta.dueDate,
                  Comments: cta.comments,
                  lookups: { CompanyId: { fields: { SfdcAccountId: cta.companySfdcId }, lookupField: "Gsid" }, OwnerId: { fields: { Email: cta.ownerEmail }, lookupField: "Gsid" } },
                },
              ],
            }),
          },
        ),
      { breaker: this.breaker, sleep: this.sleep },
    );
    if (!data.result || !data.data.success[0]) throw new UpstreamError("gainsight", 400, data.errorCode ?? "CTA_FAILED", data.errorDesc ?? JSON.stringify(data.data.failure), false);
    return { gsid: Object.values(data.data.success[0])[0] as string, created: data.message !== "already exists" };
  }
}

export class SalesloftClient {
  readonly breaker = new CircuitBreaker("salesloft");
  remainingThisMinute: number | null = null;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly sleep?: Sleep,
  ) {}

  private async call<T>(method: string, path: string, body?: Json): Promise<T> {
    return withRetry(
      "salesloft",
      async () => {
        const { data, headers } = await fetchJson<T>("salesloft", `${this.baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const rem = headers.get("x-ratelimit-remaining-minute");
        if (rem !== null) this.remainingThisMinute = Number(rem);
        return data;
      },
      { breaker: this.breaker, sleep: this.sleep },
    );
  }

  async findOrCreatePerson(p: { email: string; firstName: string; lastName: string; title: string; company: string }): Promise<number> {
    const found = await this.call<{ data: Array<{ id: number }> }>("GET", `/v2/people?email_addresses[]=${encodeURIComponent(p.email)}`);
    if (found.data[0]) return found.data[0].id;
    const created = await this.call<{ data: { id: number } }>("POST", "/v2/people", {
      email_address: p.email,
      first_name: p.firstName,
      last_name: p.lastName,
      title: p.title,
      account_name: p.company,
    });
    return created.data.id;
  }

  /** Adds a person to a cadence; "already on this cadence" (422) counts as done, so the step is safe to repeat. */
  async enroll(personId: number, cadenceId: string, userId?: string): Promise<{ membershipId: number | null; alreadyEnrolled: boolean }> {
    try {
      const res = await this.call<{ data: { id: number } }>("POST", "/v2/cadence_memberships", { person_id: personId, cadence_id: cadenceId, user_id: userId });
      return { membershipId: res.data.id, alreadyEnrolled: false };
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 422 && /already on this cadence/.test(e.message)) return { membershipId: null, alreadyEnrolled: true };
      throw e;
    }
  }
}

export class ClariClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}
  async forecast(opportunityIds: string[]): Promise<Array<{ opportunityId: string; repCall: string; managerCall: string; closeDatePushes: number; daysSinceLastActivity: number }>> {
    const { data } = await withRetry("clari", () =>
      fetchJson<{ entries: Array<{ crmOpportunityId: string; repCall: string; managerCall: string; closeDatePushes: number; daysSinceLastActivity: number }> }>(
        "clari",
        `${this.baseUrl}/v4/export/forecast/renewals`,
        {
          method: "POST",
          headers: { apikey: this.apiKey, "content-type": "application/json" },
          body: JSON.stringify({ opportunityIds }),
        },
      ),
    );
    return data.entries.map((e) => ({
      opportunityId: e.crmOpportunityId,
      repCall: e.repCall,
      managerCall: e.managerCall,
      closeDatePushes: e.closeDatePushes,
      daysSinceLastActivity: e.daysSinceLastActivity,
    }));
  }
}

export interface Registration {
  Id: string;
  PartnerId: string;
  CompanyName: string;
  CompanyDomain: string;
  EstimatedAmount: number;
  ExpectedCloseDate: string;
  Product: string;
  Status: string;
  SubmittedAt: string;
  Notes: string;
}

export class ImpartnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
  ) {}
  private headers() {
    return { authorization: `prm-key ${this.key}, tenant=sandbox`, "content-type": "application/json" };
  }
  async pending(): Promise<Registration[]> {
    const { data } = await withRetry("impartner", () =>
      fetchJson<{ data: { results: Registration[] } }>("impartner", `${this.baseUrl}/api/objects/v1/DealRegistration?status=Pending`, { headers: this.headers() }),
    );
    return data.data.results;
  }
  async get(id: string): Promise<Registration> {
    const { data } = await withRetry("impartner", () =>
      fetchJson<{ data: Registration }>("impartner", `${this.baseUrl}/api/objects/v1/DealRegistration/${encodeURIComponent(id)}`, { headers: this.headers() }),
    );
    return data.data;
  }
  async listByStatus(status: string): Promise<Registration[]> {
    const { data } = await withRetry("impartner", () =>
      fetchJson<{ data: { results: Registration[] } }>("impartner", `${this.baseUrl}/api/objects/v1/DealRegistration?status=${status}`, { headers: this.headers() }),
    );
    return data.data.results;
  }
  /** Records the decision. A registration already decided the same way is not an error (idempotent). */
  async decide(id: string, status: "Approved" | "Rejected", reason: string): Promise<void> {
    try {
      await withRetry("impartner", () =>
        fetchJson("impartner", `${this.baseUrl}/api/objects/v1/DealRegistration/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: this.headers(),
          body: JSON.stringify({ Status: status, DecisionReason: reason }),
        }),
      );
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 409) {
        const current = await this.get(id);
        if (current.Status === status) return;
      }
      throw e;
    }
  }
}

/**
 * HubSpot request validation, v3: HMAC-SHA256 over method + decoded URI + raw body + timestamp, base64, with the
 * client secret; timestamps older than five minutes are refused (replay protection). Uses the raw body: a body
 * re-serialised from parsed JSON does not reproduce what HubSpot signed.
 */
export function verifyHubspotV3(opts: { secret: string; method: string; uri: string; rawBody: string; signature: string | undefined; timestamp: string | undefined; nowMs: number }): {
  ok: boolean;
  reason?: string;
} {
  if (!opts.signature || !opts.timestamp) return { ok: false, reason: "missing signature headers" };
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts) || Math.abs(opts.nowMs - ts) > 300_000) return { ok: false, reason: "timestamp outside the five-minute window" };
  const decoded = opts.uri.replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (m) => decodeURIComponent(m));
  const expected = createHmac("sha256", opts.secret).update(`${opts.method}${decoded}${opts.rawBody}${opts.timestamp}`, "utf8").digest("base64");
  return safeEqual(expected, opts.signature) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/** Slack request signing: v0=HMAC-SHA256("v0:{timestamp}:{raw body}"), five-minute window. */
export function verifySlack(opts: { signingSecret: string; rawBody: string; signature: string | undefined; timestamp: string | undefined; nowSec: number }): { ok: boolean; reason?: string } {
  if (!opts.signature || !opts.timestamp) return { ok: false, reason: "missing signature headers" };
  if (Math.abs(opts.nowSec - Number(opts.timestamp)) > 300) return { ok: false, reason: "timestamp outside the five-minute window" };
  const expected = `v0=${createHmac("sha256", opts.signingSecret).update(`v0:${opts.timestamp}:${opts.rawBody}`).digest("hex")}`;
  return safeEqual(expected, opts.signature) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

export class SlackClient {
  constructor(
    private readonly baseUrl: string,
    private readonly botToken: string,
  ) {}
  private async call<T extends { ok: boolean; error?: string }>(method: string, body: Json): Promise<T> {
    const { data } = await withRetry("slack", () =>
      fetchJson<T>("slack", `${this.baseUrl}/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.botToken}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      }),
    );
    if (!data.ok) throw new UpstreamError("slack", 400, data.error ?? "slack_error", `${method} failed`, data.error === "ratelimited");
    return data;
  }
  async post(channel: string, text: string, blocks: Json[], metadata?: { event_type: string; event_payload: Json }): Promise<{ channel: string; ts: string }> {
    const r = await this.call<{ ok: boolean; channel: string; ts: string }>("chat.postMessage", { channel, text, blocks, metadata, unfurl_links: false });
    return { channel: r.channel, ts: r.ts };
  }
  async update(channel: string, ts: string, text: string, blocks: Json[]): Promise<void> {
    await this.call("chat.update", { channel, ts, text, blocks });
  }
}

/**
 * The warehouse: BigQuery. Queries are files in config/queries (reviewed like code), run with named parameters,
 * never built from strings. Locally the client points at the sandbox's BigQuery endpoint.
 */
export class Warehouse {
  private bq: BigQuery;
  constructor(
    private readonly projectId: string,
    apiEndpoint?: string,
  ) {
    this.bq = new BigQuery({ projectId, ...(apiEndpoint ? { apiEndpoint } : {}) });
  }
  async run<T>(name: string, params: Record<string, string | number>): Promise<T[]> {
    const sql = readRepoFile("config", "queries", `${name}.sql`).replace(/\$\{project\}/g, this.projectId);
    const [rows] = await this.bq.query({ query: sql, params, location: "EU" });
    return rows as T[];
  }
  async insert(dataset: string, table: string, rows: Array<{ insertId: string; json: Json }>): Promise<void> {
    // insertId lets BigQuery drop a row sent twice by a retry (best-effort de-duplication)
    await this.bq.dataset(dataset).table(table).insert(rows, { raw: true, ignoreUnknownValues: true });
  }
}
