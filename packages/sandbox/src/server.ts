import { ManualClock } from "@revops/core";
import Fastify, { type FastifyInstance } from "fastify";
import { GtmSystems, type SandboxKeys, hubspotSignatureV3, registerGtm, slackSignature } from "./gtm";
import { SalesforceOrg, registerSalesforce } from "./salesforce";
import { type World, generateWorld } from "./world";

export const DEFAULT_KEYS: SandboxKeys & { sfClientId: string; sfClientSecret: string; truthToken: string } = {
  sfClientId: "sandbox-client",
  sfClientSecret: "sandbox-secret",
  gainsightAccessKey: "gs-sandbox-key",
  salesloftApiKey: "sl-sandbox-key",
  clariApiKey: "clari-sandbox-key",
  impartnerKey: "prm-sandbox-key",
  hubspotClientSecret: "hs-sandbox-secret",
  hubspotAppToken: "hs-sandbox-token",
  slackBotToken: "xoxb-sandbox",
  slackSigningSecret: "slack-sandbox-signing-secret",
  truthToken: "truth-only-for-evaluation",
};

export interface Sandbox {
  app: FastifyInstance;
  world: World;
  org: SalesforceOrg;
  gtm: GtmSystems;
  clock: ManualClock;
}

/**
 * The GTM sandbox: one HTTP server that stands in for Salesforce, Gainsight, Salesloft, Clari, Impartner, HubSpot,
 * Slack and BigQuery, plus `/_sandbox` controls (time, faults, webhook deliveries, simulated people). Truth about the
 * world is served only under `/_sandbox/truth` with a token the platform does not have.
 */
export function buildSandbox(opts: { seed?: number; asOf?: string; keys?: typeof DEFAULT_KEYS } = {}): Sandbox {
  const keys = opts.keys ?? DEFAULT_KEYS;
  const world = generateWorld(opts.seed ?? 7, opts.asOf ?? "2026-10-26");
  const clock = new ManualClock(`${world.asOf}T09:00:00Z`);
  const org = new SalesforceOrg(world, clock);
  const gtm = new GtmSystems(world, clock);
  const app = Fastify({ logger: false, bodyLimit: 5_000_000 });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  registerSalesforce(app, org, { clientId: keys.sfClientId, clientSecret: keys.sfClientSecret });
  registerGtm(app, gtm, keys);

  app.get("/_sandbox/health", async () => ({ ok: true, now: clock.now().toISOString() }));
  app.post("/_sandbox/clock", async (req) => {
    const b = req.body as { advanceMs?: number; set?: string };
    if (b.set) clock.set(b.set);
    if (b.advanceMs) clock.advance(b.advanceMs);
    return { now: clock.now().toISOString() };
  });
  app.post("/_sandbox/faults", async (req) => {
    const b = req.body as { lockRowEvery?: number; unavailableEvery?: number; salesforceApiUsed?: number; salesforceDailyMax?: number; salesloftLimitPerMinute?: number };
    org.faults = { lockRowEvery: b.lockRowEvery ?? 0, unavailableEvery: b.unavailableEvery ?? 0 };
    if (b.salesforceApiUsed !== undefined) org.apiUsed = b.salesforceApiUsed;
    if (b.salesforceDailyMax !== undefined) org.dailyMax = b.salesforceDailyMax;
    if (b.salesloftLimitPerMinute !== undefined) gtm.salesloftMinute.limit = b.salesloftLimitPerMinute;
    return { ok: true, limits: org.limits() };
  });

  /** Deliver form submissions to a webhook URL the way HubSpot does: JSON body, v3 signature, millisecond timestamp. */
  app.post("/_sandbox/hubspot/deliver", async (req) => {
    const b = req.body as { url: string; ids?: string[]; from?: number; count?: number; tamper?: boolean };
    const forms = b.ids ? world.forms.filter((f) => b.ids?.includes(f.submissionId)) : world.forms.slice(b.from ?? 0, (b.from ?? 0) + (b.count ?? 1));
    const results: Array<{ id: string; status: number }> = [];
    for (const f of forms) {
      const body = JSON.stringify([{ subscriptionType: "form.submission", occurredAt: new Date(f.submittedAt).getTime(), objectId: f.submissionId, properties: f }]);
      const ts = String(clock.now().getTime());
      const url = new URL(b.url);
      const sig = hubspotSignatureV3(keys.hubspotClientSecret, "POST", url.href, b.tamper ? `${body} ` : body, ts);
      const res = await fetch(b.url, { method: "POST", headers: { "content-type": "application/json", "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts }, body });
      results.push({ id: f.submissionId, status: res.status });
    }
    return { delivered: results };
  });

  /** A signal on a renewal: the rep pushes the close date, which Salesforce publishes as a change event. */
  app.post("/_sandbox/scenario/push-close-date", async (req) => {
    const b = req.body as { opportunityId: string; days: number };
    const opp = org.table("Opportunity").get(b.opportunityId);
    if (!opp) return { ok: false };
    const d = new Date(String(opp.CloseDate));
    d.setUTCDate(d.getUTCDate() + b.days);
    org.update("Opportunity", b.opportunityId, { CloseDate: d.toISOString().slice(0, 10) });
    return { ok: true, closeDate: d.toISOString().slice(0, 10) };
  });

  /**
   * Simulated people answer open approval messages in Slack the way a careful colleague would: the ADR picks the real
   * intent, the CSM approves a save play only for a renewal that is really at risk, the partner manager decides the
   * registration correctly. `errorRate` makes them occasionally wrong. Answers are signed like Slack interactions.
   */
  app.post("/_sandbox/people/act", async (req) => {
    const b = req.body as { interactionsUrl: string; errorRate?: number; limit?: number };
    const open = gtm.slack.filter((m) => m.metadata?.event_type === "revops_approval" && !m.metadata.event_payload.answered).slice(0, b.limit ?? 100);
    const answered: Array<{ approvalId: string; action: string; status: number }> = [];
    let k = 0;
    for (const m of open) {
      const p = m.metadata?.event_payload as { approvalId: string; kind: string; subjectId: string; proposal: Record<string, unknown> };
      const wrong = b.errorRate ? ((k++ * 7919) % 1000) / 1000 < b.errorRate : false;
      let action = "approve";
      let value: Record<string, unknown> = {};
      if (p.kind === "lead") {
        const t = world.truth.forms[p.subjectId];
        const intent = wrong ? "demo_request" : t?.intent;
        if (intent && intent !== p.proposal.intent) {
          action = "edit";
          value = { intent };
        }
      } else if (p.kind === "renewal") {
        const t = world.truth.renewals[p.subjectId];
        action = (t?.atRisk ?? false) !== wrong ? "approve" : "reject";
      } else if (p.kind === "deal_registration") {
        const t = world.truth.registrations[p.subjectId];
        const decision = wrong ? "approve" : ((t?.decision === "escalate" ? "reject" : t?.decision) ?? "approve");
        action = decision === p.proposal.decision ? "approve" : "edit";
        if (action === "edit") value = { decision };
      }
      const user = world.users.find((u) => u.Role === (p.kind === "lead" ? "ADR" : p.kind === "renewal" ? "CSM" : "PartnerManager"));
      const payload = {
        type: "block_actions",
        user: { id: user?.SlackUserId ?? "U0000", username: user?.Name ?? "someone" },
        channel: { id: m.channel },
        message: { ts: m.ts, metadata: m.metadata },
        actions: [{ action_id: action, block_id: "decision", value: JSON.stringify({ approvalId: p.approvalId, ...value }), type: "button" }],
        response_url: `${req.protocol}://${req.headers.host}/_sandbox/slack/response`,
      };
      const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
      const ts = String(Math.floor(clock.now().getTime() / 1000));
      const res = await fetch(b.interactionsUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": slackSignature(keys.slackSigningSecret, ts, body) },
        body,
      });
      if (res.ok) (p as unknown as { answered: boolean }).answered = true;
      answered.push({ approvalId: p.approvalId, action, status: res.status });
    }
    return { answered };
  });
  app.post("/_sandbox/slack/response", async () => ({ ok: true }));

  app.get("/_sandbox/state", async () => ({
    now: clock.now().toISOString(),
    salesforce: { apiUsed: org.apiUsed, leads: org.table("Lead").size, tasks: org.table("Task").size },
    gainsight: { ctas: gtm.ctas.length },
    salesloft: { people: gtm.people.length, memberships: gtm.memberships.length },
    impartner: { decisions: gtm.registrationDecisions.length },
    slack: { messages: gtm.slack.length },
    bigquery: Object.fromEntries(Object.entries(gtm.bqInserts).map(([k, v]) => [k, v.length])),
  }));
  app.get("/_sandbox/inspect/:what", async (req, reply) => {
    const what = (req.params as { what: string }).what;
    const data: Record<string, unknown> = {
      leads: [...org.table("Lead").values()],
      tasks: [...org.table("Task").values()],
      ctas: gtm.ctas,
      memberships: gtm.memberships,
      slack: gtm.slack,
      decisions: gtm.registrationDecisions,
    };
    return what in data ? data[what] : reply.code(404).send({ error: "unknown" });
  });

  app.get("/_sandbox/truth", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${keys.truthToken}`) return reply.code(403).send({ error: "truth is for the evaluation only" });
    return { asOf: world.asOf, truth: world.truth, forms: world.forms, registrations: world.registrations };
  });

  return { app, world, org, gtm, clock };
}
