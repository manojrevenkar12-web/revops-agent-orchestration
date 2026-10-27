/**
 * The orchestrator's HTTP surface (Cloud Run):
 *   POST /webhooks/hubspot      HubSpot form submissions (signature v3) -> message start of inbound-lead-routing
 *   POST /slack/interactions    Approve / change / decline buttons (Slack signing secret) -> approval.decided
 *   POST /jobs/renewal-scan     Cloud Scheduler, weekly: renewals in the window -> renewal.signal
 *   POST /jobs/registration-poll Cloud Scheduler, every 10 minutes: pending registrations -> registration message
 *   GET  /api/...               the control-room console (read-only; behind IAP in production)
 *
 * Every inbound event becomes a Camunda message with a message id, so a webhook delivered twice, a double click in
 * Slack or a scheduler retry never starts or decides anything twice.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { AuditLog, Clock } from "@revops/core";
import { safeEqual } from "@revops/core";
import { type SlackClient, verifyHubspotV3, verifySlack } from "@revops/connectors";
import Fastify, { type FastifyInstance } from "fastify";
import { OAuth2Client } from "google-auth-library";
import type { McpGateway } from "./clients";
import { computeMetrics } from "./metrics";
import { automations, dealRegistrationPolicy, leadPolicy, renewalPolicy } from "./policy";
import { type Approvals, isOpen } from "./approvals";
import { decidedBlocks } from "./slack";

type Json = Record<string, unknown>;

export interface ApiDeps {
  camunda: CamundaClient;
  mcp: McpGateway;
  slack: SlackClient;
  approvals: Approvals;
  audit: AuditLog;
  clock: Clock;
  hubspotSecret: string;
  slackSigningSecret: string;
  schedulerToken?: string;
  schedulerServiceAccount?: string; // production: verify Cloud Scheduler's OIDC token for this account
  schedulerAudience?: string;
  publicBaseUrl: () => string;
  consoleDir?: string;
  engineRecordsUrl?: string; // local engine only: the record stream for instance histories
}

const isAlreadyExists = (e: unknown) => /ALREADY_EXISTS|already published|409/.test(String((e as Error)?.message ?? e) + JSON.stringify((e as { body?: unknown })?.body ?? ""));

export function buildApi(d: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const now = () => d.clock.now();
  const audit = (action: string, subject: string, outcome: "ok" | "denied" | "error" | "pending", detail: Json = {}) =>
    d.audit.append({ at: now().toISOString(), actor: "api", action, subject, outcome, detail });

  // Signatures are computed over the exact bytes received, so these routes keep the raw body.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));
  const json = (raw: unknown): Json => {
    if (typeof raw !== "string" || !raw) return {};
    return JSON.parse(raw) as Json;
  };

  app.get("/healthz", async () => ({ ok: true, at: now().toISOString() }));

  // ---- HubSpot ------------------------------------------------------------------------------------------------------
  app.post("/webhooks/hubspot", async (req, reply) => {
    const raw = String(req.body ?? "");
    const check = verifyHubspotV3({
      secret: d.hubspotSecret,
      method: "POST",
      uri: `${d.publicBaseUrl()}${req.url}`,
      rawBody: raw,
      signature: req.headers["x-hubspot-signature-v3"] as string | undefined,
      timestamp: req.headers["x-hubspot-request-timestamp"] as string | undefined,
      nowMs: now().getTime(),
    });
    if (!check.ok) {
      audit("webhook.rejected", "hubspot", "denied", { reason: check.reason });
      return reply.code(401).send({ error: check.reason });
    }
    const events = JSON.parse(raw) as Array<{ subscriptionType: string; objectId: string; properties: Json }>;
    const cfg = automations().inbound_lead_routing;
    let accepted = 0;
    let duplicates = 0;
    for (const e of events.filter((x) => x.subscriptionType === "form.submission")) {
      const submission = { ...e.properties, submissionId: e.objectId };
      try {
        await d.camunda.publishMessage({
          name: cfg.message,
          correlationKey: e.objectId,
          messageId: e.objectId,
          timeToLive: 3_600_000,
          variables: { submission, policy: leadPolicy(), receivedAt: now().toISOString() },
        } as never);
        accepted++;
        audit("webhook.received", `submission/${e.objectId}`, "ok", { source: "hubspot" });
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        duplicates++;
      }
    }
    return { accepted, duplicates };
  });

  // ---- Slack --------------------------------------------------------------------------------------------------------
  app.post("/slack/interactions", async (req, reply) => {
    const raw = String(req.body ?? "");
    const check = verifySlack({
      signingSecret: d.slackSigningSecret,
      rawBody: raw,
      signature: req.headers["x-slack-signature"] as string | undefined,
      timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
      nowSec: Math.floor(now().getTime() / 1000),
    });
    if (!check.ok) {
      audit("slack.rejected", "slack", "denied", { reason: check.reason });
      return reply.code(401).send({ error: check.reason });
    }
    const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as {
      type: string;
      user: { id: string; username?: string; name?: string };
      channel?: { id: string };
      message?: { ts: string; metadata?: { event_payload?: { kind?: string; subjectId?: string } } };
      actions?: Array<{ action_id: string; value?: string; selected_option?: { value: string } }>;
    };
    const action = payload.actions?.[0];
    if (payload.type !== "block_actions" || !action) return { ok: true };
    const value = JSON.parse(action.value ?? action.selected_option?.value ?? "{}") as { approvalId?: string; intent?: string; decision?: string };
    if (!value.approvalId) return { response_type: "ephemeral", text: "This button does not belong to a request." };
    const meta = payload.message?.metadata?.event_payload ?? {};
    const outcome = action.action_id === "edit" ? "edit" : action.action_id === "reject" ? "reject" : "approve";
    const edits = outcome === "edit" ? (value.intent ? { intent: value.intent } : value.decision ? { decision: value.decision } : null) : null;
    const decision = { outcome, by: `slack:${payload.user.id}`, byName: payload.user.username ?? payload.user.name ?? payload.user.id, edits, at: now().toISOString() };
    // Correlate, not publish: if no instance is waiting (already decided, expired, double click), nothing happens and
    // the person is told so.
    let processInstanceKey: string;
    try {
      const r = await d.camunda.correlateMessage({ name: "approval.decided", correlationKey: value.approvalId, variables: { decision } } as never);
      processInstanceKey = String(r.processInstanceKey);
    } catch (err) {
      if (/NOT_FOUND|404|no process instance is waiting/i.test(String((err as Error).message) + JSON.stringify((err as { body?: unknown }).body ?? ""))) {
        return { response_type: "ephemeral", text: "This request is no longer open: it was already decided or its deadline passed." };
      }
      throw err;
    }
    audit("approval.decided", `process/${processInstanceKey}`, "ok", { approvalId: value.approvalId, kind: meta.kind, outcome, override: outcome !== "approve", by: decision.by });
    if (payload.channel?.id && payload.message?.ts) {
      await d.slack
        .update(
          payload.channel.id,
          payload.message.ts,
          `Decision recorded: ${outcome}`,
          decidedBlocks(`*${String(meta.kind ?? "request").replace("_", " ")}* ${meta.subjectId ?? ""}`, outcome, decision.byName),
        )
        .catch(() => undefined);
    }
    return { ok: true };
  });

  // ---- scheduled jobs (Cloud Scheduler with an OIDC token in production; a shared token locally) ------------------
  // Cloud Scheduler sends a Google-signed ID token for the scheduler service account; locally a shared token is used.
  const oidc = d.schedulerServiceAccount ? new OAuth2Client() : null;
  const scheduler = async (auth: string | undefined): Promise<boolean> => {
    const token = (auth ?? "").replace(/^Bearer\s+/i, "");
    if (d.schedulerToken && safeEqual(token, d.schedulerToken)) return true;
    if (!oidc || !token) return false;
    try {
      const ticket = await oidc.verifyIdToken({ idToken: token, audience: d.schedulerAudience ?? d.publicBaseUrl() });
      const p = ticket.getPayload();
      return !!p?.email_verified && p.email === d.schedulerServiceAccount;
    } catch {
      return false;
    }
  };

  app.post("/jobs/renewal-scan", async (req, reply) => {
    if (!(await scheduler(req.headers.authorization))) return reply.code(401).send({ error: "unauthorized" });
    const cfg = automations().renewal_risk;
    const { renewals } = await d.mcp.call<{ renewals: Array<{ opportunityId: string; accountId: string }> }>("renewals_due", { within_days: cfg.renewal_window_days });
    const week = `${now().getUTCFullYear()}-${Math.ceil((now().getTime() - Date.UTC(now().getUTCFullYear(), 0, 1)) / (7 * 86_400_000))}`;
    let started = 0;
    for (const r of renewals) {
      try {
        await d.camunda.publishMessage({
          name: cfg.message,
          correlationKey: r.opportunityId,
          messageId: `scan-${r.opportunityId}-${week}`,
          timeToLive: 0,
          variables: { opportunityId: r.opportunityId, accountId: r.accountId, trigger: "weekly_scan", policy: renewalPolicy() },
        } as never);
        started++;
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
    }
    audit("scan.renewals", "renewal-risk-save-play", "ok", { renewals: renewals.length, published: started });
    return { renewals: renewals.length, published: started };
  });

  app.post("/jobs/registration-poll", async (req, reply) => {
    if (!(await scheduler(req.headers.authorization))) return reply.code(401).send({ error: "unauthorized" });
    const cfg = automations().partner_deal_registration;
    const { registrations } = await d.mcp.call<{ registrations: Array<{ id: string }> }>("registrations_pending", {});
    let started = 0;
    for (const r of registrations) {
      try {
        await d.camunda.publishMessage({
          name: cfg.message,
          correlationKey: r.id,
          messageId: r.id,
          timeToLive: 3_600_000,
          variables: { registrationId: r.id, policy: dealRegistrationPolicy() },
        } as never);
        started++;
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
    }
    audit("poll.registrations", "partner-deal-registration", "ok", { pending: registrations.length, started });
    return { pending: registrations.length, started };
  });

  // ---- console API --------------------------------------------------------------------------------------------------
  const now0 = { consistency: { waitUpToMs: 0 } };
  app.get("/api/overview", async () => computeMetrics({ audit: d.audit, approvals: d.approvals, camunda: d.camunda, now: now() }));

  app.get<{ Querystring: { process?: string; state?: string; limit?: string } }>("/api/instances", async (req) => {
    const filter: Json = {};
    if (req.query.process) filter.processDefinitionId = req.query.process;
    if (req.query.state) filter.state = req.query.state;
    const r = await d.camunda.searchProcessInstances({ filter, page: { limit: Math.min(Number(req.query.limit ?? 50), 200) }, sort: [{ field: "startDate", order: "DESC" }] } as never, now0 as never);
    return { items: (r.items ?? []).map((i) => ({ ...i, processInstanceKey: String(i.processInstanceKey), processDefinitionKey: String(i.processDefinitionKey) })) };
  });

  app.get<{ Params: { key: string } }>("/api/instances/:key", async (req, reply) => {
    const pis = await d.camunda.searchProcessInstances({ filter: { processInstanceKey: req.params.key } } as never, now0 as never);
    const pi = pis.items?.[0];
    if (!pi) return reply.code(404).send({ error: "not found" });
    const els = await d.camunda.searchElementInstances({ filter: { processInstanceKey: req.params.key }, page: { limit: 500 } } as never, now0 as never);
    const xml = await d.camunda.getProcessDefinitionXml({ processDefinitionKey: pi.processDefinitionKey } as never, now0 as never).catch(() => null);
    const vars = await d.camunda.searchVariables({ filter: { processInstanceKey: req.params.key }, page: { limit: 500 } } as never, now0 as never).catch(() => ({ items: [] }));
    const auditTrail = d.audit.list((e) => e.subject === `process/${req.params.key}`, 500).reverse();
    const variables = Object.fromEntries(
      (vars.items ?? [])
        .filter((v) => String(v.scopeKey) === req.params.key)
        .map((v) => {
          let val: unknown = v.value;
          try {
            val = JSON.parse(String(v.value));
          } catch {
            /* keep text */
          }
          return [v.name, redact(v.name, val)];
        }),
    );
    return {
      instance: { ...pi, processInstanceKey: String(pi.processInstanceKey), processDefinitionKey: String(pi.processDefinitionKey) },
      elements: (els.items ?? []).map((e) => ({
        elementId: e.elementId,
        elementName: e.elementName,
        type: e.type,
        state: e.state,
        startDate: e.startDate,
        endDate: e.endDate ?? null,
        hasIncident: e.hasIncident,
      })),
      xml,
      variables,
      audit: auditTrail,
    };
  });

  app.get<{ Querystring: { state?: string } }>("/api/approvals", async (req) => {
    const items = await d.approvals.list((r) => (req.query.state === "open" ? isOpen(r) : req.query.state === "decided" ? !!r.decision : true));
    return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200) };
  });

  app.get<{ Querystring: { limit?: string; action?: string } }>("/api/audit", async (req) => ({
    verified: d.audit.verify(),
    items: d.audit.list((e) => !req.query.action || e.action === req.query.action, Math.min(Number(req.query.limit ?? 200), 1000)),
  }));

  app.get("/api/incidents", async () => {
    const r = await d.camunda.searchIncidents({ filter: { state: "ACTIVE" }, page: { limit: 100 } } as never, now0 as never);
    return { items: (r.items ?? []).map((i) => ({ ...i, incidentKey: String(i.incidentKey), processInstanceKey: String(i.processInstanceKey), jobKey: i.jobKey ? String(i.jobKey) : null })) };
  });

  app.get("/api/tools", async () => ({ tools: await d.mcp.listTools() }));

  app.get("/api/policy", async () => ({ automations: automations() }));

  // ---- the console's static files -----------------------------------------------------------------------------------
  if (d.consoleDir && existsSync(d.consoleDir)) {
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };
    app.get("/*", async (req, reply) => {
      const p = req.url.split("?")[0] ?? "/";
      const file = join(d.consoleDir as string, p === "/" || !extname(p) ? "index.html" : p.replace(/\.\./g, ""));
      if (!existsSync(file)) return reply.code(404).send("not found");
      return reply.type(types[extname(file)] ?? "application/octet-stream").send(readFileSync(file));
    });
  }
  return app;
}

/** The console shows process variables, but not the e-mail addresses and messages people sent, or approval tokens. */
function redact(name: string, v: unknown): unknown {
  if (name === "approvals") return "[approval tokens]";
  const walk = (x: unknown, key = ""): unknown => {
    if (typeof x === "string") return key === "message" ? `${x.slice(0, 80)}…` : x.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g, "$1***@");
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Json).map(([k, y]) => [k, walk(y, k)]));
    return x;
  };
  return walk(v, name);
}
