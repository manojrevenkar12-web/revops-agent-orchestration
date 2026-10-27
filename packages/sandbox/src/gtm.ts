/**
 * Emulators for the rest of the GTM stack, each with the request shape, authentication and failure behaviour of the
 * real API that the connectors are written against:
 *
 * - Gainsight: data-object query for health history, Cockpit `POST /v2/cockpit/cta/` (Accesskey header,
 *   referenceId mandatory, success/failure arrays).
 * - Salesloft: people lookup and cadence memberships (Bearer key, per-minute rate limit headers, 422 when a person
 *   is already on the cadence).
 * - Clari: forecast export per opportunity.
 * - Impartner PRM: deal registrations (pending list, decision PATCH).
 * - HubSpot: contact read, and the webhook sender that signs deliveries with X-HubSpot-Signature-v3.
 * - Slack Web API: chat.postMessage / chat.update captured for inspection.
 * - BigQuery: jobs.insert, jobs.query, getQueryResults and insertAll over an in-memory SQL engine, so the official
 *   @google-cloud/bigquery client can be pointed at it with `apiEndpoint`.
 */
import { createHmac } from "node:crypto";
import type { Clock } from "@revops/core";
import alasql from "alasql";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { World } from "./world";

type Row = Record<string, unknown>;

export interface SandboxKeys {
  gainsightAccessKey: string;
  salesloftApiKey: string;
  clariApiKey: string;
  impartnerKey: string;
  hubspotClientSecret: string;
  hubspotAppToken: string;
  slackBotToken: string;
  slackSigningSecret: string;
}

export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  blocks: Row[];
  metadata?: { event_type: string; event_payload: Row };
  updates: number;
}

export class GtmSystems {
  ctas: Row[] = [];
  memberships: Row[] = [];
  people: Row[] = [];
  slack: SlackMessage[] = [];
  registrationDecisions: Row[] = [];
  bqInserts: Record<string, Row[]> = {};
  salesloftMinute = { window: 0, used: 0, limit: 600 };
  readonly bqJobs = new Map<string, { sql: string; params: never[] }>();
  seq = 0;
  readonly db: InstanceType<typeof alasql.Database>;

  constructor(
    readonly world: World,
    readonly clock: Clock,
  ) {
    // the product-usage warehouse: one in-memory database per sandbox, so two sandboxes never share data
    this.db = new alasql.Database();
    this.db.exec("CREATE TABLE product_product_usage_weekly; CREATE TABLE support_tickets");
    const tables = this.db.tables as Record<string, { data: unknown[] }>;
    (tables.product_product_usage_weekly as { data: unknown[] }).data = world.usage.map((u) => ({ ...u }));
    (tables.support_tickets as { data: unknown[] }).data = world.tickets.map((t) => ({ ...t }));
  }
}

const unauthorized = (reply: FastifyReply, body: Row = { error: "unauthorized" }) => reply.code(401).send(body);

export function registerGtm(app: FastifyInstance, g: GtmSystems, keys: SandboxKeys): void {
  const w = g.world;

  // ---- Gainsight ------------------------------------------------------------------------------------------------
  app.post("/v1/data/objects/query/HealthScoreHistory", async (req, reply) => {
    if (req.headers.accesskey !== keys.gainsightAccessKey) return unauthorized(reply, { result: false, errorCode: "GS_AUTH", errorDesc: "invalid access key" });
    const b = req.body as { where?: { conditions?: Array<{ name: string; value: string[] }> }; limit?: number };
    const ids = b.where?.conditions?.find((c) => c.name === "SfdcAccountId")?.value ?? [];
    const records = w.health.filter((h) => ids.includes(h.sfdc_account_id)).map((h) => ({ SfdcAccountId: h.sfdc_account_id, WeekStart: h.week_start, Score: h.score }));
    return { result: true, errorCode: null, errorDesc: null, data: { records: records.slice(0, b.limit ?? 500) } };
  });
  app.post("/v2/cockpit/cta/", async (req, reply) => {
    if (req.headers.accesskey !== keys.gainsightAccessKey) return unauthorized(reply, { result: false, errorCode: "GS_AUTH", errorDesc: "invalid access key" });
    const b = req.body as { requests?: Row[] };
    const r = b.requests?.[0];
    if (!r || b.requests!.length !== 1) return reply.code(400).send({ result: false, errorCode: "COCKPIT_9701", errorDesc: "exactly one CTA per request" });
    const missing = ["referenceId", "Name", "TypeName"].filter((k) => !r[k]);
    const lookups = (r.lookups ?? {}) as Row;
    if (!lookups.CompanyId || !lookups.OwnerId) missing.push("CompanyId/OwnerId lookups");
    if (missing.length) return reply.code(400).send({ result: false, errorCode: "COCKPIT_9700", errorDesc: `mandatory fields missing: ${missing.join(", ")}` });
    const existing = g.ctas.find((c) => c.referenceId === r.referenceId);
    if (existing) return { result: true, requestId: `req-${++g.seq}`, data: { success: [{ [r.referenceId as string]: existing.Gsid }], failure: [] }, message: "already exists" };
    const gsid = `1S01${String(g.ctas.length + 1).padStart(14, "0")}`;
    g.ctas.push({ ...r, Gsid: gsid, CreatedAt: g.clock.now().toISOString() });
    return { result: true, errorCode: null, errorDesc: null, requestId: `req-${g.ctas.length}`, data: { success: [{ [r.referenceId as string]: gsid }], failure: [] }, message: null };
  });

  // ---- Salesloft --------------------------------------------------------------------------------------------------
  const salesloftAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.headers.authorization !== `Bearer ${keys.salesloftApiKey}`) {
      void unauthorized(reply);
      return false;
    }
    const minute = Math.floor(g.clock.now().getTime() / 60_000);
    if (g.salesloftMinute.window !== minute) g.salesloftMinute = { ...g.salesloftMinute, window: minute, used: 0 };
    g.salesloftMinute.used += 10; // Salesloft charges cost units per request
    reply.header("x-ratelimit-limit-minute", g.salesloftMinute.limit).header("x-ratelimit-remaining-minute", Math.max(0, g.salesloftMinute.limit - g.salesloftMinute.used));
    if (g.salesloftMinute.used > g.salesloftMinute.limit) {
      void reply
        .code(429)
        .header("retry-after", 60 - (Math.floor(g.clock.now().getTime() / 1000) % 60))
        .send({ error: "rate limit exceeded" });
      return false;
    }
    return true;
  };
  app.get("/v2/people", async (req, reply) => {
    if (!salesloftAuth(req, reply)) return reply;
    const q = req.query as Record<string, string | string[]>;
    const emails = ([] as string[]).concat(q["email_addresses[]"] ?? []).map((e) => e.toLowerCase());
    return { data: g.people.filter((p) => emails.includes(String(p.email_address).toLowerCase())), metadata: { paging: { per_page: 25, current_page: 1 } } };
  });
  app.post("/v2/people", async (req, reply) => {
    if (!salesloftAuth(req, reply)) return reply;
    const b = req.body as Row;
    if (!b.email_address) return reply.code(422).send({ errors: { email_address: ["can't be blank"] } });
    if (g.people.some((p) => p.email_address === b.email_address)) return reply.code(422).send({ errors: { email_address: ["has already been taken"] } });
    const p = { id: 7_000_000 + g.people.length, ...b, created_at: g.clock.now().toISOString() };
    g.people.push(p);
    return { data: p };
  });
  app.post("/v2/cadence_memberships", async (req, reply) => {
    if (!salesloftAuth(req, reply)) return reply;
    const b = { ...(req.query as Row), ...((req.body as Row) ?? {}) };
    const personId = Number(b.person_id);
    if (!g.people.some((p) => p.id === personId)) return reply.code(404).send({ error: "person not found" });
    if (g.memberships.some((m) => m.person_id === personId && m.cadence_id === b.cadence_id && m.currently_on_cadence)) {
      return reply.code(422).send({ errors: { person_id: ["is already on this cadence"] } });
    }
    const m = { id: 9_000_000 + g.memberships.length, person_id: personId, cadence_id: b.cadence_id, user_id: b.user_id ?? null, currently_on_cadence: true, added_at: g.clock.now().toISOString() };
    g.memberships.push(m);
    return { data: m };
  });

  // ---- Clari ------------------------------------------------------------------------------------------------------
  app.post("/v4/export/forecast/:forecastId", async (req, reply) => {
    if (req.headers.apikey !== keys.clariApiKey) return unauthorized(reply);
    const b = (req.body ?? {}) as { opportunityIds?: string[] };
    const rows = w.forecast.filter((f) => !b.opportunityIds || b.opportunityIds.includes(f.opportunity_id));
    return {
      forecastId: (req.params as { forecastId: string }).forecastId,
      entries: rows.map((f) => ({
        crmOpportunityId: f.opportunity_id,
        repCall: f.rep_call,
        managerCall: f.manager_call,
        closeDatePushes: f.close_date_pushes,
        daysSinceLastActivity: f.days_since_last_activity,
      })),
    };
  });

  // ---- Impartner PRM ----------------------------------------------------------------------------------------------
  const prmAuth = (req: FastifyRequest) => req.headers.authorization === `prm-key ${keys.impartnerKey}, tenant=sandbox`;
  app.get("/api/objects/v1/DealRegistration", async (req, reply) => {
    if (!prmAuth(req)) return unauthorized(reply);
    const status = (req.query as Record<string, string>).status;
    const data = w.registrations.filter((r) => !status || r.Status === status);
    return { success: true, data: { count: data.length, results: data } };
  });
  app.get("/api/objects/v1/DealRegistration/:id", async (req, reply) => {
    if (!prmAuth(req)) return unauthorized(reply);
    const r = w.registrations.find((x) => x.Id === (req.params as { id: string }).id);
    return r ? { success: true, data: r } : reply.code(404).send({ success: false, message: "not found" });
  });
  app.patch("/api/objects/v1/DealRegistration/:id", async (req, reply) => {
    if (!prmAuth(req)) return unauthorized(reply);
    const r = w.registrations.find((x) => x.Id === (req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ success: false, message: "not found" });
    const b = req.body as { Status?: "Approved" | "Rejected"; DecisionReason?: string };
    if (r.Status !== "Pending" && b.Status && b.Status !== r.Status) return reply.code(409).send({ success: false, message: `registration is already ${r.Status}` });
    if (b.Status) r.Status = b.Status;
    g.registrationDecisions.push({ id: r.Id, status: r.Status, reason: b.DecisionReason ?? null, at: g.clock.now().toISOString() });
    return { success: true, data: r };
  });

  // ---- HubSpot ----------------------------------------------------------------------------------------------------
  app.get("/crm/v3/objects/contacts/:email", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${keys.hubspotAppToken}`) return unauthorized(reply);
    const email = decodeURIComponent((req.params as { email: string }).email);
    const f = w.forms.find((x) => x.email === email);
    if (!f) return reply.code(404).send({ status: "error", message: "resource not found" });
    return {
      id: f.submissionId.replace("hs-", ""),
      properties: { email: f.email, firstname: f.firstname, lastname: f.lastname, company: f.company, jobtitle: f.jobtitle, country: f.country, hs_analytics_source: f.utm_source },
    };
  });

  // ---- Slack Web API ----------------------------------------------------------------------------------------------
  const slackAuth = (req: FastifyRequest) => req.headers.authorization === `Bearer ${keys.slackBotToken}`;
  app.post("/api/chat.postMessage", async (req) => {
    if (!slackAuth(req)) return { ok: false, error: "invalid_auth" };
    const b = req.body as { channel: string; text?: string; blocks?: Row[]; metadata?: SlackMessage["metadata"] };
    if (!b.channel) return { ok: false, error: "channel_not_found" };
    if ((b.blocks?.length ?? 0) > 50) return { ok: false, error: "invalid_blocks" };
    const ts = `${Math.floor(g.clock.now().getTime() / 1000)}.${String(g.slack.length + 1).padStart(6, "0")}`;
    const msg: SlackMessage = { channel: b.channel, ts, text: b.text ?? "", blocks: b.blocks ?? [], metadata: b.metadata, updates: 0 };
    g.slack.push(msg);
    return { ok: true, channel: b.channel, ts, message: { text: msg.text, blocks: msg.blocks } };
  });
  app.post("/api/chat.update", async (req) => {
    if (!slackAuth(req)) return { ok: false, error: "invalid_auth" };
    const b = req.body as { channel: string; ts: string; text?: string; blocks?: Row[] };
    const m = g.slack.find((x) => x.channel === b.channel && x.ts === b.ts);
    if (!m) return { ok: false, error: "message_not_found" };
    m.blocks = b.blocks ?? m.blocks;
    m.text = b.text ?? m.text;
    m.updates++;
    return { ok: true, channel: m.channel, ts: m.ts };
  });

  // ---- BigQuery ---------------------------------------------------------------------------------------------------
  const runSql = (sql: string, params: Array<{ name?: string; parameterType: { type: string }; parameterValue: { value?: unknown } }> = []) => {
    const ordered: unknown[] = [];
    const translated = sql
      .replace(/`([\w-]+)\.(\w+)\.(\w+)`/g, (_, _p, d: string, t: string) => `${d}_${t}`)
      .replace(/`(\w+)\.(\w+)`/g, (_, d: string, t: string) => `${d}_${t}`)
      .replace(/@(\w+)/g, (_, name: string) => {
        const p = params.find((x) => x.name === name);
        if (!p) throw new Error(`Query parameter '${name}' not found`);
        const v = p.parameterValue.value;
        ordered.push(p.parameterType.type === "INT64" || p.parameterType.type === "FLOAT64" ? Number(v) : v);
        return "?";
      });
    if (/^\s*(insert|update|delete|drop|create|alter)\b/i.test(translated)) throw new Error("only SELECT is allowed in the emulator");
    return g.db.exec(translated, ordered as never) as Row[];
  };
  const toBqResponse = (rows: Row[], jobId: string, projectId: string) => {
    const fields = rows[0] ? Object.keys(rows[0]) : [];
    const type = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? "INTEGER" : "FLOAT") : typeof v === "boolean" ? "BOOLEAN" : "STRING");
    return {
      kind: "bigquery#getQueryResultsResponse",
      jobReference: { projectId, jobId, location: "EU" },
      jobComplete: true,
      totalRows: String(rows.length),
      schema: { fields: fields.map((f) => ({ name: f, type: type((rows[0] as Row)[f]), mode: "NULLABLE" })) },
      rows: rows.map((r) => ({ f: fields.map((f) => ({ v: r[f] === null || r[f] === undefined ? null : String(r[f]) })) })),
    };
  };
  app.post("/bigquery/v2/projects/:projectId/jobs", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const b = req.body as { jobReference?: { jobId?: string }; configuration?: { query?: { query: string; queryParameters?: never[] } } };
    const q = b.configuration?.query;
    if (!q) return reply.code(400).send({ error: { code: 400, message: "only query jobs are supported" } });
    const jobId = b.jobReference?.jobId ?? `job_${++g.seq}`;
    try {
      runSql(q.query, q.queryParameters);
    } catch (e) {
      return reply.code(400).send({ error: { code: 400, message: (e as Error).message, errors: [{ reason: "invalidQuery", message: (e as Error).message }] } });
    }
    g.bqJobs.set(jobId, { sql: q.query, params: q.queryParameters ?? [] });
    return {
      kind: "bigquery#job",
      id: `${projectId}:EU.${jobId}`,
      jobReference: { projectId, jobId, location: "EU" },
      status: { state: "DONE" },
      configuration: b.configuration,
      statistics: { creationTime: String(Date.now()) },
    };
  });
  app.get("/bigquery/v2/projects/:projectId/queries/:jobId", async (req, reply) => {
    const { projectId, jobId } = req.params as { projectId: string; jobId: string };
    const job = g.bqJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: { code: 404, message: `Not found: Job ${jobId}` } });
    return toBqResponse(runSql(job.sql, job.params), jobId, projectId);
  });
  app.get("/bigquery/v2/projects/:projectId/jobs/:jobId", async (req) => {
    const { projectId, jobId } = req.params as { projectId: string; jobId: string };
    return { kind: "bigquery#job", jobReference: { projectId, jobId, location: "EU" }, status: { state: "DONE" } };
  });
  app.post("/bigquery/v2/projects/:projectId/queries", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const b = req.body as { query: string; queryParameters?: never[] };
    try {
      return toBqResponse(runSql(b.query, b.queryParameters), `job_${Date.now()}`, projectId);
    } catch (e) {
      return reply.code(400).send({ error: { code: 400, message: (e as Error).message } });
    }
  });
  app.post("/bigquery/v2/projects/:projectId/datasets/:dataset/tables/:table/insertAll", async (req) => {
    const { dataset, table } = req.params as { dataset: string; table: string };
    const b = req.body as { rows: Array<{ insertId?: string; json: Row }> };
    const key = `${dataset}.${table}`;
    g.bqInserts[key] ??= [];
    const seen = new Set(g.bqInserts[key].map((r) => r.__insertId));
    for (const r of b.rows) if (!r.insertId || !seen.has(r.insertId)) g.bqInserts[key].push({ ...r.json, __insertId: r.insertId });
    return { kind: "bigquery#tableDataInsertAllResponse" };
  });
}

/** HubSpot v3 signature over method + decoded URI + body + timestamp, as HubSpot computes it. */
export function hubspotSignatureV3(secret: string, method: string, uri: string, body: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${method}${uri}${body}${timestamp}`, "utf8").digest("base64");
}

/** Slack's v0 request signature. */
export function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}
