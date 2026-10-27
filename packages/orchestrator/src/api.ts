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
import type { McpGateway } from "./clients";
import { computeMetrics } from "./metrics";
import { automations, dealRegistrationPolicy, leadPolicy, renewalPolicy } from "./policy";
import { type ApprovalStore, decidedBlocks } from "./slack";

type Json = Record<string, unknown>;

export interface ApiDeps {
  camunda: CamundaClient;
  mcp: McpGateway;
  slack: SlackClient;
  approvals: ApprovalStore;
  audit: AuditLog;
  clock: Clock;
  hubspotSecret: string;
  slackSigningSecret: string;
  schedulerToken: string;
  publicBaseUrl: () => string;
  seen: { has: (k: string) => boolean; add: (k: string) => void };
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
      actions?: Array<{ action_id: string; value?: string; selected_option?: { value: string } }>;
    };
    const action = payload.actions?.[0];
    if (payload.type !== "block_actions" || !action) return { ok: true };
    const value = JSON.parse(action.value ?? action.selected_option?.value ?? "{}") as { approvalId?: string; intent?: string; decision?: string };
    const rec = value.approvalId ? d.approvals.get(value.approvalId) : undefined;
    if (!rec) return { response_type: "ephemeral", text: "This request is no longer open." };
    if (rec.decision) return { response_type: "ephemeral", text: `Already decided (${rec.decision.outcome}) by ${rec.decision.by}.` };
    const outcome = action.action_id === "edit" ? "edit" : action.action_id === "reject" ? "reject" : "approve";
    const edits = outcome === "edit" ? (value.intent ? { intent: value.intent } : value.decision ? { decision: value.decision } : null) : null;
    const decision = { outcome, by: `slack:${payload.user.id}`, byName: payload.user.username ?? payload.user.name ?? payload.user.id, edits, at: now().toISOString() };
    try {
      await d.camunda.publishMessage({ name: "approval.decided", correlationKey: rec.approvalId, messageId: `${rec.approvalId}:decision`, timeToLive: 3_600_000, variables: { decision } } as never);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return { response_type: "ephemeral", text: "Already recorded." };
    }
    d.approvals.put({ ...rec, decidedAt: decision.at, decision: { outcome, by: decision.by, edits }, override: outcome !== "approve" });
    audit("approval.decided", `process/${rec.processInstanceKey}`, "ok", { approvalId: rec.approvalId, kind: rec.kind, outcome, override: outcome !== "approve", by: decision.by });
    await d.slack.update(rec.channel, rec.ts, `Decision recorded: ${outcome}`, decidedBlocks(`*${rec.kind.replace("_", " ")}* ${rec.subjectId}`, outcome, decision.byName)).catch(() => undefined);
    return { ok: true };
  });

  // ---- scheduled jobs (Cloud Scheduler with an OIDC token in production; a shared token locally) ------------------
  const scheduler = (auth: string | undefined) => safeEqual(auth ?? "", `Bearer ${d.schedulerToken}`);

  app.post("/jobs/renewal-scan", async (req, reply) => {
    if (!scheduler(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
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
    if (!scheduler(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const cfg = automations().partner_deal_registration;
    const { registrations } = await d.mcp.call<{ registrations: Array<{ id: string }> }>("registrations_pending", {});
    let started = 0;
    for (const r of registrations) {
      if (d.seen.has(`registration:${r.id}`)) continue;
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
      d.seen.add(`registration:${r.id}`);
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
    const items = d.approvals.list((r) => (req.query.state === "open" ? !r.decision && !r.closedAt : req.query.state === "decided" ? !!r.decision : true));
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

/** The console shows process variables, but not the e-mail addresses and messages people sent. */
function redact(name: string, v: unknown): unknown {
  if (name === "submission" && v && typeof v === "object") {
    const s = v as Json;
    return { ...s, email: typeof s.email === "string" ? s.email.replace(/^(.).*@/, "$1***@") : s.email, message: typeof s.message === "string" ? `${s.message.slice(0, 80)}…` : s.message };
  }
  if (name === "approvals") return "[approval tokens]";
  if (name === "lead" && v && typeof v === "object") return { ...(v as Json), email: "[redacted]" };
  return v;
}
