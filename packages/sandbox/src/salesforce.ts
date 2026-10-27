/**
 * A Salesforce org emulator: REST (query with paging, sObject CRUD, upsert by external ID, composite), Bulk API 2.0
 * query jobs with CSV results and locators, the /limits resource and the Sforce-Limit-Info header, daily API limits
 * (REQUEST_LIMIT_EXCEEDED), transient faults (UNABLE_TO_LOCK_ROW, 503), and Change Data Capture with opaque replay
 * IDs and a 72-hour retention window.
 *
 * It is tested with jsforce, the client a Node integration would use against a real org, so the integration code is
 * exercised through a real client library rather than through mocks of its own making.
 */
import type { Clock } from "@revops/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Query, type SoqlError, execute, parseSoql } from "./soql";
import type { World } from "./world";

export const API_VERSION = "v62.0";
const RETENTION_MS = 72 * 3600 * 1000;

type Row = Record<string, unknown>;

/** Field lists per object; anything else is INVALID_FIELD, as in a real org without that field. */
const SCHEMA: Record<string, { prefix: string; fields: string[]; parents?: Record<string, { field: string; object: string }> }> = {
  User: { prefix: "005", fields: ["Id", "Name", "Email", "Role", "Region", "Segment__c", "SlackUserId", "IsActive"] },
  Account: {
    prefix: "001",
    fields: ["Id", "Name", "Website", "Industry", "BillingCountry", "Region__c", "NumberOfEmployees", "Segment__c", "Type", "OwnerId", "CSM__c", "ARR__c", "Renewal_Date__c", "SystemModstamp"],
    parents: { Owner: { field: "OwnerId", object: "User" }, CSM__r: { field: "CSM__c", object: "User" } },
  },
  Contact: {
    prefix: "003",
    fields: ["Id", "AccountId", "FirstName", "LastName", "Email", "Title", "Champion__c", "Left_Company__c", "SystemModstamp"],
    parents: { Account: { field: "AccountId", object: "Account" } },
  },
  Opportunity: {
    prefix: "006",
    fields: ["Id", "AccountId", "Name", "Type", "StageName", "CloseDate", "Amount", "ForecastCategoryName", "OwnerId", "Partner_Account__c", "IsClosed", "CreatedDate", "SystemModstamp"],
    parents: { Account: { field: "AccountId", object: "Account" }, Owner: { field: "OwnerId", object: "User" }, Partner_Account__r: { field: "Partner_Account__c", object: "Account" } },
  },
  Lead: {
    prefix: "00Q",
    fields: [
      "Id",
      "FirstName",
      "LastName",
      "Email",
      "Company",
      "Title",
      "Country",
      "Status",
      "LeadSource",
      "OwnerId",
      "Intent__c",
      "Routing_Queue__c",
      "HubSpot_Submission_Id__c",
      "Matched_Account__c",
      "SystemModstamp",
    ],
    parents: { Owner: { field: "OwnerId", object: "User" }, Matched_Account__r: { field: "Matched_Account__c", object: "Account" } },
  },
  Task: {
    prefix: "00T",
    fields: ["Id", "WhatId", "WhoId", "Subject", "Description", "OwnerId", "ActivityDate", "Status", "Priority", "External_Key__c", "SystemModstamp"],
    parents: { Owner: { field: "OwnerId", object: "User" } },
  },
};
const EXTERNAL_IDS: Record<string, string[]> = { Lead: ["HubSpot_Submission_Id__c"], Task: ["External_Key__c"] };

export interface ChangeEvent {
  replayId: string; // opaque, base64 of a counter: callers must not do arithmetic on it
  topic: string; // "/data/OpportunityChangeEvent"
  committedAt: number;
  payload: {
    ChangeEventHeader: { entityName: string; recordIds: string[]; changeType: "CREATE" | "UPDATE" | "DELETE"; changedFields: string[]; commitTimestamp: number; transactionKey: string };
    [field: string]: unknown;
  };
}

export class SalesforceOrg {
  readonly tables = new Map<string, Map<string, Row>>();
  private seq = 0;
  private events: ChangeEvent[] = [];
  private eventSeq = 1000;
  apiUsed = 0;
  dailyMax: number;
  faults: { lockRowEvery: number; unavailableEvery: number } = { lockRowEvery: 0, unavailableEvery: 0 };
  private calls = 0;
  private bulkJobs = new Map<string, { query: Query; object: string; state: string; rows: Row[]; created: number }>();
  private queryLocators = new Map<string, { rows: Row[]; pos: number; fields: string[]; object: string }>();

  constructor(
    world: World,
    private readonly clock: Clock,
    dailyMax = 100_000,
  ) {
    this.dailyMax = dailyMax;
    for (const name of Object.keys(SCHEMA)) this.tables.set(name, new Map());
    const load = (obj: string, rows: Row[]) => {
      const t = this.tables.get(obj) as Map<string, Row>;
      for (const r of rows) t.set(r.Id as string, { ...r });
    };
    load("User", world.users as unknown as Row[]);
    load("Account", world.accounts as unknown as Row[]);
    load("Contact", world.contacts as unknown as Row[]);
    load("Opportunity", world.opportunities as unknown as Row[]);
  }

  table(obj: string): Map<string, Row> {
    const t = this.tables.get(obj);
    if (!t) throw new SfError(404, "NOT_FOUND", `The requested resource does not exist: sObject type '${obj}' is not supported.`);
    return t;
  }

  private newId(obj: string): string {
    const prefix = SCHEMA[obj]?.prefix ?? "a00";
    this.seq++;
    return `${prefix}Sb${String(this.seq).padStart(13, "0")}`;
  }

  get(row: Row, path: string): unknown {
    if (!path.includes(".")) return row[path];
    const [rel, field] = path.split(".") as [string, string];
    const obj = Object.entries(SCHEMA).find(([, s]) => s.parents?.[rel])?.[1].parents?.[rel];
    if (!obj) return undefined;
    const parent = this.tables.get(obj.object)?.get(row[obj.field] as string);
    return parent ? parent[field] : null;
  }

  private checkFields(obj: string, fields: string[]): void {
    const s = SCHEMA[obj];
    if (!s) throw new SfError(400, "INVALID_TYPE", `sObject type '${obj}' is not supported.`);
    for (const f of fields) {
      if (f.includes(".")) {
        const [rel, sub] = f.split(".") as [string, string];
        const p = s.parents?.[rel];
        if (!p || !SCHEMA[p.object]?.fields.includes(sub)) throw new SfError(400, "INVALID_FIELD", `No such column '${f}' on entity '${obj}'.`);
      } else if (!s.fields.includes(f)) throw new SfError(400, "INVALID_FIELD", `No such column '${f}' on entity '${obj}'.`);
    }
  }

  /** Count an API call against the daily limit and apply configured faults. */
  meter(): void {
    this.calls++;
    if (this.apiUsed >= this.dailyMax) throw new SfError(403, "REQUEST_LIMIT_EXCEEDED", "TotalRequests Limit exceeded.");
    this.apiUsed++;
    if (this.faults.unavailableEvery && this.calls % this.faults.unavailableEvery === 0) throw new SfError(503, "SERVER_UNAVAILABLE", "Service temporarily unavailable.");
  }

  query(soql: string, batchSize = 2000): Row {
    let q: Query;
    try {
      q = parseSoql(soql);
    } catch (e) {
      throw new SfError(400, "MALFORMED_QUERY", (e as SoqlError).message);
    }
    this.checkFields(q.object, [...q.fields, ...q.orderBy.map((o) => o.field)]);
    const rows = [...this.table(q.object).values()];
    const res = execute(q, rows, (r, p) => this.get(r, p), this.clock.now());
    if (q.count) return { totalSize: res.total, done: true, records: [] };
    const shaped = res.rows.map((r) => this.shape(q.object, r, q.fields));
    return this.page(shaped, q.object, q.fields, batchSize);
  }

  private page(rows: Row[], object: string, fields: string[], batchSize: number): Row {
    const first = rows.slice(0, batchSize);
    const out: Row = { totalSize: rows.length, done: rows.length <= batchSize, records: first };
    if (rows.length > batchSize) {
      const locator = `01g${String(++this.seq).padStart(15, "0")}-${batchSize}`;
      this.queryLocators.set(locator, { rows, pos: batchSize, fields, object });
      out.nextRecordsUrl = `/services/data/${API_VERSION}/query/${locator}`;
    }
    return out;
  }

  queryMore(locator: string): Row {
    const st = this.queryLocators.get(locator);
    if (!st) throw new SfError(400, "INVALID_QUERY_LOCATOR", "invalid query locator");
    const batch = Number(locator.split("-")[1] ?? 2000);
    const records = st.rows.slice(st.pos, st.pos + batch);
    st.pos += batch;
    const done = st.pos >= st.rows.length;
    if (done) this.queryLocators.delete(locator);
    return { totalSize: st.rows.length, done, records, ...(done ? {} : { nextRecordsUrl: `/services/data/${API_VERSION}/query/${locator}` }) };
  }

  shape(object: string, r: Row, fields: string[]): Row {
    const out: Row = { attributes: { type: object, url: `/services/data/${API_VERSION}/sobjects/${object}/${r.Id}` } };
    for (const f of fields) {
      if (f.includes(".")) {
        const [rel, sub] = f.split(".") as [string, string];
        const parentObj = SCHEMA[object]?.parents?.[rel]?.object as string;
        const v = this.get(r, f);
        const existing = (out[rel] as Row | null | undefined) ?? (v === null ? null : { attributes: { type: parentObj } });
        if (existing) existing[sub] = v;
        out[rel] = existing;
      } else out[f] = r[f] ?? null;
    }
    return out;
  }

  retrieve(object: string, id: string, fields?: string[]): Row {
    const r = this.table(object).get(id);
    if (!r) throw new SfError(404, "NOT_FOUND", "The requested resource does not exist");
    return this.shape(object, r, fields ?? (SCHEMA[object]?.fields as string[]));
  }

  private lockFault(): void {
    if (this.faults.lockRowEvery && this.calls % this.faults.lockRowEvery === 0) throw new SfError(400, "UNABLE_TO_LOCK_ROW", "unable to obtain exclusive access to this record");
  }

  create(object: string, body: Row): { id: string; success: true; errors: [] } {
    this.lockFault();
    this.checkFields(
      object,
      Object.keys(body).filter((k) => k !== "attributes"),
    );
    const id = this.newId(object);
    const { attributes: _attributes, ...fields } = body;
    const row: Row = { ...fields, Id: id, SystemModstamp: this.clock.now().toISOString() };
    this.table(object).set(id, row);
    this.emit(object, id, "CREATE", Object.keys(row), row);
    return { id, success: true, errors: [] };
  }

  update(object: string, id: string, body: Row): void {
    this.lockFault();
    const t = this.table(object);
    const r = t.get(id);
    if (!r) throw new SfError(404, "NOT_FOUND", "The requested resource does not exist");
    const fields = Object.keys(body).filter((k) => k !== "attributes" && k !== "Id");
    this.checkFields(object, fields);
    const changed = fields.filter((f) => r[f] !== body[f]);
    for (const f of fields) r[f] = body[f];
    r.SystemModstamp = this.clock.now().toISOString();
    if (changed.length) this.emit(object, id, "UPDATE", changed, Object.fromEntries(changed.map((f) => [f, r[f]])));
  }

  upsert(object: string, extField: string, value: string, body: Row): { id: string; created: boolean; success: true; errors: [] } {
    if (!EXTERNAL_IDS[object]?.includes(extField)) throw new SfError(400, "INVALID_FIELD", `Field ${extField} is not an external ID field on ${object}.`);
    const matches = [...this.table(object).values()].filter((r) => r[extField] === value);
    if (matches.length > 1) throw new SfError(300, "MULTIPLE_CHOICES", "more than one record matches the external ID");
    if (matches.length === 1) {
      const id = (matches[0] as Row).Id as string;
      this.update(object, id, body);
      return { id, created: false, success: true, errors: [] };
    }
    const res = this.create(object, { ...body, [extField]: value });
    return { id: res.id, created: true, success: true, errors: [] };
  }

  // ---- change data capture ----------------------------------------------------------------------------------------
  private emit(object: string, id: string, changeType: ChangeEvent["payload"]["ChangeEventHeader"]["changeType"], changedFields: string[], values: Row): void {
    if (!["Opportunity", "Account", "Contact", "Lead"].includes(object)) return;
    const n = ++this.eventSeq;
    const replayId = encodeReplay(n);
    const at = this.clock.now().getTime();
    this.events.push({
      replayId,
      topic: `/data/${object}ChangeEvent`,
      committedAt: at,
      payload: {
        ChangeEventHeader: { entityName: object, recordIds: [id], changeType, changedFields, commitTimestamp: at, transactionKey: `tx-${n}` },
        ...values,
      },
    });
  }

  /**
   * Pub/Sub API semantics over HTTP: LATEST, EARLIEST, or CUSTOM with a stored replay ID. A replay ID older than the
   * retention window is refused, as Salesforce refuses it, and the subscriber must re-synchronise.
   */
  subscribe(topic: string, preset: "LATEST" | "EARLIEST" | "CUSTOM", replayId: string | null, numRequested: number): { events: ChangeEvent[]; latestReplayId: string | null } {
    const cutoff = this.clock.now().getTime() - RETENTION_MS;
    const onTopic = (e: ChangeEvent) => topic === "/data/ChangeEvents" || e.topic === topic;
    const retained = this.events.filter((e) => e.committedAt >= cutoff && onTopic(e));
    const head = encodeReplay(this.eventSeq); // a position, valid even when no event has been published yet
    let after = -1;
    if (preset === "LATEST") after = this.eventSeq;
    else if (preset === "CUSTOM") {
      if (!replayId) throw new SfError(400, "INVALID_ARGUMENT", "a replay ID is required with CUSTOM");
      after = decodeReplay(replayId);
      // resuming here would skip events that have already been purged: refuse, as Salesforce does
      const purgedAfter = this.events.some((e) => onTopic(e) && decodeReplay(e.replayId) > after && e.committedAt < cutoff);
      const own = this.events.find((e) => e.replayId === replayId);
      const expired = own !== undefined && own.committedAt < cutoff;
      if (Number.isNaN(after) || after > this.eventSeq || purgedAfter || expired) {
        throw new SfError(400, "REPLAY_ID_NOT_AVAILABLE", "The replay ID is not available: events after it are older than the retention window.");
      }
    }
    const events = retained.filter((e) => decodeReplay(e.replayId) > after).slice(0, numRequested);
    return { events, latestReplayId: events.at(-1)?.replayId ?? (preset === "CUSTOM" && replayId ? replayId : head) };
  }

  // ---- bulk api 2.0 ----------------------------------------------------------------------------------------------
  createBulkQuery(soql: string): Row {
    let q: Query;
    try {
      q = parseSoql(soql);
    } catch (e) {
      throw new SfError(400, "INVALIDJOB", (e as SoqlError).message);
    }
    this.checkFields(q.object, q.fields);
    const id = `750Sb${String(++this.seq).padStart(13, "0")}`;
    const res = execute(q, [...this.table(q.object).values()], (r, p) => this.get(r, p), this.clock.now());
    this.bulkJobs.set(id, { query: q, object: q.object, state: "UploadComplete", rows: res.rows, created: Date.now() });
    return { id, operation: "query", object: q.object, state: "UploadComplete", apiVersion: Number(API_VERSION.slice(1)), contentType: "CSV" };
  }

  bulkStatus(id: string): Row {
    const j = this.bulkJobs.get(id);
    if (!j) throw new SfError(404, "NOT_FOUND", "job not found");
    // the first poll sees the job running; the next sees it complete, as a client must handle
    j.state = j.state === "UploadComplete" ? "InProgress" : "JobComplete";
    return { id, state: j.state, object: j.object, numberRecordsProcessed: j.state === "JobComplete" ? j.rows.length : 0 };
  }

  bulkResults(id: string, locator: string | null, maxRecords: number): { csv: string; next: string | null; count: number } {
    const j = this.bulkJobs.get(id);
    if (!j) throw new SfError(404, "NOT_FOUND", "job not found");
    if (j.state !== "JobComplete") throw new SfError(400, "INVALIDJOB", "the job is not complete");
    const start = locator ? Number(Buffer.from(locator, "base64url").toString()) : 0;
    const slice = j.rows.slice(start, start + maxRecords);
    const esc = (v: unknown) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [j.query.fields.join(","), ...slice.map((r) => j.query.fields.map((f) => esc(this.get(r, f))).join(","))];
    const nextPos = start + slice.length;
    return { csv: `${lines.join("\n")}\n`, next: nextPos < j.rows.length ? Buffer.from(String(nextPos)).toString("base64url") : null, count: slice.length };
  }

  limits(): Row {
    return { DailyApiRequests: { Max: this.dailyMax, Remaining: Math.max(0, this.dailyMax - this.apiUsed) }, DailyBulkV2QueryJobs: { Max: 10_000, Remaining: 10_000 - this.bulkJobs.size } };
  }
}

function encodeReplay(n: number): string {
  return Buffer.from(n.toString(16).padStart(16, "0"), "hex").toString("base64");
}

function decodeReplay(id: string): number {
  return Number.parseInt(Buffer.from(id, "base64").toString("hex"), 16);
}

export class SfError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerSalesforce(app: FastifyInstance, org: SalesforceOrg, opts: { clientId: string; clientSecret: string }): void {
  const base = `/services/data/${API_VERSION}`;
  const token = "00DSb000000sandbox!sandbox-access-token";
  const authed = (req: FastifyRequest) => req.headers.authorization === `Bearer ${token}` || req.headers.authorization === `OAuth ${token}`;
  const handle =
    (fn: (req: FastifyRequest, reply: FastifyReply) => unknown, metered = true) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!authed(req)) return reply.code(401).send([{ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid" }]);
      try {
        if (metered) org.meter();
        const out = await fn(req, reply);
        reply.header("Sforce-Limit-Info", `api-usage=${org.apiUsed}/${org.dailyMax}`);
        return out;
      } catch (e) {
        if (e instanceof SfError) {
          reply.header("Sforce-Limit-Info", `api-usage=${org.apiUsed}/${org.dailyMax}`);
          return reply.code(e.status).send([{ errorCode: e.errorCode, message: e.message }]);
        }
        throw e;
      }
    };

  app.post("/services/oauth2/token", async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (b.grant_type !== "client_credentials" || b.client_id !== opts.clientId || b.client_secret !== opts.clientSecret) {
      return reply.code(400).send({ error: "invalid_client", error_description: "invalid client credentials" });
    }
    const host = `${req.protocol}://${req.headers.host}`;
    return { access_token: token, instance_url: host, token_type: "Bearer", issued_at: String(Date.now()), id: `${host}/id/00DSb000000sandbox/005Sb0000000001` };
  });

  app.get(
    `${base}/limits`,
    handle(() => org.limits(), false),
  );
  app.get(
    `${base}/query`,
    handle((req) => {
      const q = (req.query as Record<string, string>).q;
      const opt = String(req.headers["sforce-query-options"] ?? "");
      const batch = Number(/batchSize=(\d+)/.exec(opt)?.[1] ?? 2000);
      return org.query(q ?? "", Math.min(Math.max(batch, 200), 2000));
    }),
  );
  app.get(
    `${base}/query/:locator`,
    handle((req) => org.queryMore((req.params as { locator: string }).locator)),
  );
  app.get(
    `${base}/sobjects/:object/:id`,
    handle((req) => {
      const p = req.params as { object: string; id: string };
      const fields = (req.query as Record<string, string>).fields?.split(",");
      return org.retrieve(p.object, p.id, fields);
    }),
  );
  app.post(
    `${base}/sobjects/:object`,
    handle((req, reply) => {
      reply.code(201);
      return org.create((req.params as { object: string }).object, req.body as Row);
    }),
  );
  app.patch(
    `${base}/sobjects/:object/:id`,
    handle((req, reply) => {
      const p = req.params as { object: string; id: string };
      org.update(p.object, p.id, req.body as Row);
      return reply.code(204).send();
    }),
  );
  app.patch(
    `${base}/sobjects/:object/:field/:value`,
    handle((req, reply) => {
      const p = req.params as { object: string; field: string; value: string };
      const res = org.upsert(p.object, p.field, decodeURIComponent(p.value), req.body as Row);
      reply.code(res.created ? 201 : 200);
      return res;
    }),
  );
  app.post(
    `${base}/composite`,
    handle((req) => {
      const body = req.body as { allOrNone?: boolean; compositeRequest: Array<{ method: string; url: string; referenceId: string; body?: Row }> };
      const results: Row[] = [];
      const refs = new Map<string, Row>();
      const snapshot = body.allOrNone ? structuredClone([...org.tables.entries()].map(([k, v]) => [k, [...v.entries()]])) : null;
      for (const sub of body.compositeRequest) {
        const url = sub.url.replace(/@\{([^}.]+)\.([^}]+)\}/g, (_, ref: string, f: string) => String(refs.get(ref)?.[f] ?? ""));
        const m = new RegExp(`^/services/data/${API_VERSION}/sobjects/([^/]+)(?:/([^/]+))?(?:/([^/]+))?$`).exec(url);
        try {
          if (!m) throw new SfError(400, "INVALID_URL", `unsupported composite url ${sub.url}`);
          const [, object, a, b] = m as unknown as [string, string, string | undefined, string | undefined];
          let res: Row;
          if (sub.method === "POST") res = { httpStatusCode: 201, body: org.create(object, sub.body ?? {}) };
          else if (sub.method === "PATCH" && b) {
            const r = org.upsert(object, a as string, decodeURIComponent(b), sub.body ?? {});
            res = { httpStatusCode: r.created ? 201 : 200, body: r };
          } else if (sub.method === "PATCH" && a) {
            org.update(object, a, sub.body ?? {});
            res = { httpStatusCode: 204, body: null };
          } else if (sub.method === "GET" && a) res = { httpStatusCode: 200, body: org.retrieve(object, a) };
          else throw new SfError(400, "METHOD_NOT_ALLOWED", `${sub.method} is not supported in this emulator`);
          refs.set(sub.referenceId, (res.body as Row) ?? {});
          results.push({ ...res, referenceId: sub.referenceId, httpHeaders: {} });
        } catch (e) {
          const err = e instanceof SfError ? e : new SfError(500, "UNKNOWN_EXCEPTION", String(e));
          results.push({ httpStatusCode: err.status, referenceId: sub.referenceId, body: [{ errorCode: err.errorCode, message: err.message }] });
          if (body.allOrNone) {
            if (snapshot) for (const [k, entries] of snapshot as Array<[string, Array<[string, Row]>]>) org.tables.set(k, new Map(entries));
            return {
              compositeResponse: body.compositeRequest.map((s) => ({
                httpStatusCode: s.referenceId === sub.referenceId ? err.status : 400,
                referenceId: s.referenceId,
                body: [
                  {
                    errorCode: s.referenceId === sub.referenceId ? err.errorCode : "PROCESSING_HALTED",
                    message: s.referenceId === sub.referenceId ? err.message : "The transaction was rolled back since another operation in the same transaction failed.",
                  },
                ],
              })),
            };
          }
        }
      }
      return { compositeResponse: results };
    }),
  );

  app.post(
    `${base}/jobs/query`,
    handle((req) => org.createBulkQuery((req.body as { query: string }).query)),
  );
  app.get(
    `${base}/jobs/query/:id`,
    handle((req) => org.bulkStatus((req.params as { id: string }).id)),
  );
  app.get(
    `${base}/jobs/query/:id/results`,
    handle((req, reply) => {
      const q = req.query as Record<string, string>;
      const res = org.bulkResults((req.params as { id: string }).id, q.locator ?? null, Number(q.maxRecords ?? 50_000));
      reply
        .header("Content-Type", "text/csv")
        .header("Sforce-Locator", res.next ?? "null")
        .header("Sforce-NumberOfRecords", String(res.count));
      return res.csv;
    }),
  );

  // Pub/Sub API stand-in (the real one is gRPC; this keeps its replay semantics)
  app.post(
    "/pubsub/subscribe",
    handle((req) => {
      const b = req.body as { topicName: string; replayPreset: "LATEST" | "EARLIEST" | "CUSTOM"; replayId?: string; numRequested?: number };
      return org.subscribe(b.topicName, b.replayPreset, b.replayId ?? null, Math.min(b.numRequested ?? 100, 100));
    }, false),
  );
}
