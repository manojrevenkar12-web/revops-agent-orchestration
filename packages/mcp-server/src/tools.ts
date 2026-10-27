import { type Connectors, UpstreamError, soqlQuote } from "@revops/connectors";
import { type AuditLog, type Clock, sha256 } from "@revops/core";
/**
 * The GTM tools. Each returns structured content (for agents and processes) and a short text summary (for people
 * using Claude Desktop). Read tools return curated fields, not whole records; e-mail addresses are masked unless the
 * caller has the gtm:pii scope. Write tools need an approval token for exactly the arguments being written, and
 * each write is idempotent (external IDs, reference IDs, already-enrolled counts as done).
 */
import { z } from "zod";
import { argsHash, verifyApproval } from "./approval";
import type { PlaybookIndex } from "./retrieval";

export interface Caller {
  client: string;
  scopes: Set<string>;
}

export interface ToolContext {
  c: Connectors;
  playbooks: PlaybookIndex;
  audit: AuditLog;
  clock: Clock;
  approvalSecret: string;
  maxRows: number;
  usedApprovals: Map<string, unknown>; // jti -> first result (production: Firestore with a TTL)
}

export interface Fact {
  id: string;
  label: string;
  value: string | number | boolean | null;
  source: string;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  scope: "gtm:read" | "gtm:write";
  write: boolean;
  input: S;
  run: (args: z.objectOutputType<S, z.ZodTypeAny>, ctx: ToolContext, caller: Caller) => Promise<{ summary: string; data: Record<string, unknown> }>;
}

const mask = (email: string, caller: Caller) => (caller.scopes.has("gtm:pii") ? email : email.replace(/^(.).*@/, "$1***@"));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const days = (a: string, b: Date) => Math.round((new Date(a).getTime() - b.getTime()) / 86_400_000);
const pct = (from: number, to: number) => (from === 0 ? 0 : Math.round(((to - from) / from) * 1000) / 10);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Rec = Record<string, unknown> & { Id: string };

export const TOOLS: ToolDef[] = [
  {
    name: "account_lookup",
    title: "Find a Salesforce account",
    description: "Find accounts by web domain (preferred), name or Account Id. Use before any other account tool when you only have a company name or an e-mail address.",
    scope: "gtm:read",
    write: false,
    input: {
      domain: z.string().max(120).optional(),
      name: z.string().max(120).optional(),
      account_id: z
        .string()
        .regex(/^001[A-Za-z0-9]{12,15}$/)
        .optional(),
    },
    async run(a, ctx) {
      if (!a.domain && !a.name && !a.account_id) throw new UpstreamError("mcp", 400, "INVALID_ARGUMENT", "give a domain, a name or an account id", false);
      const where = a.account_id
        ? `Id = ${soqlQuote(a.account_id)}`
        : a.domain
          ? `Website LIKE ${soqlQuote(`%${a.domain.replace(/^www\./, "").replace(/[%_]/g, "")}%`)}`
          : `Name LIKE ${soqlQuote(`%${(a.name ?? "").replace(/[%_]/g, "")}%`)}`;
      const rows = await ctx.c.salesforce.query<Rec>(
        `SELECT Id, Name, Website, Type, Segment__c, Region__c, NumberOfEmployees, OwnerId, Owner.Name, Owner.IsActive, CSM__c FROM Account WHERE ${where} LIMIT ${ctx.maxRows}`,
        { priority: "interactive" },
      );
      const accounts = rows.map((r) => ({
        id: r.Id,
        name: r.Name,
        website: r.Website,
        type: r.Type,
        segment: r.Segment__c,
        region: r.Region__c,
        employees: r.NumberOfEmployees,
        ownerId: r.OwnerId,
        ownerName: (r.Owner as Rec | null)?.Name ?? null,
        ownerActive: (r.Owner as Rec | null)?.IsActive ?? null,
        csmId: r.CSM__c,
      }));
      return { summary: accounts.length ? accounts.map((x) => `${x.name} (${x.type}, ${x.segment}, ${x.region})`).join("; ") : "no matching account", data: { accounts } };
    },
  },
  {
    name: "account_360",
    title: "Account 360 with citable facts",
    description:
      "Everything the GTM stack knows about one account: Salesforce record, open opportunities, renewal, contacts (champion status), Gainsight health trend, product usage trend from BigQuery, support tickets, Clari forecast calls. Returns `facts`, each with an id you must cite when you use it.",
    scope: "gtm:read",
    write: false,
    input: { account_id: z.string().regex(/^001[A-Za-z0-9]{12,15}$/, "a Salesforce Account Id") },
    async run(a, ctx, caller) {
      const now = ctx.clock.now();
      const [acc] = await ctx.c.salesforce.query<Rec>(`SELECT Id, Name, Type, Segment__c, Region__c, ARR__c, Renewal_Date__c, OwnerId, CSM__c FROM Account WHERE Id = ${soqlQuote(a.account_id)}`, {
        priority: "interactive",
      });
      if (!acc) throw new UpstreamError("mcp", 404, "NOT_FOUND", `no account ${a.account_id}`, false);
      const opps = await ctx.c.salesforce.query<Rec>(
        `SELECT Id, Name, Type, StageName, CloseDate, Amount, ForecastCategoryName FROM Opportunity WHERE AccountId = ${soqlQuote(a.account_id)} AND IsClosed = false ORDER BY CloseDate`,
        { priority: "interactive" },
      );
      const contacts = await ctx.c.salesforce.query<Rec>(
        `SELECT Id, FirstName, LastName, Email, Title, Champion__c, Left_Company__c FROM Contact WHERE AccountId = ${soqlQuote(a.account_id)} LIMIT ${ctx.maxRows}`,
        { priority: "interactive" },
      );
      const [health, usage, tickets] = await Promise.all([
        ctx.c.gainsight.healthHistory(a.account_id).catch(() => []),
        ctx.c.warehouse.run<{ week_start: string; active_process_instances: number; active_users: number }>("usage_trend", { account_id: a.account_id }).catch(() => []),
        ctx.c.warehouse.run<{ severity: string; status: string; opened: string }>("support_tickets", { account_id: a.account_id }).catch(() => []),
      ]);
      const renewal = opps.find((o) => o.Type === "Renewal");
      const forecast = renewal ? (await ctx.c.clari.forecast([renewal.Id]).catch(() => []))[0] : undefined;
      const facts: Fact[] = [];
      const add = (id: string, label: string, value: Fact["value"], source: string) => facts.push({ id, label, value, source });
      add("account.arr", "Annual recurring revenue (EUR)", (acc.ARR__c as number) ?? null, "salesforce:Account.ARR__c");
      if (renewal) {
        add("renewal.close_date", "Renewal close date", renewal.CloseDate as string, "salesforce:Opportunity.CloseDate");
        add("renewal.days_to_close", "Days until the renewal closes", days(renewal.CloseDate as string, now), "salesforce:Opportunity.CloseDate");
        add("renewal.forecast_category", "Forecast category in Salesforce", renewal.ForecastCategoryName as string, "salesforce:Opportunity.ForecastCategoryName");
      }
      if (usage.length >= 8) {
        const pis = usage.map((u) => Number(u.active_process_instances));
        const users = usage.map((u) => Number(u.active_users));
        add(
          "usage.process_instances_change_pct",
          "Change in weekly process instances, last 4 weeks vs first 4 of 12",
          pct(mean(pis.slice(0, 4)), mean(pis.slice(-4))),
          "bigquery:product.product_usage_weekly",
        );
        add(
          "usage.active_users_change_pct",
          "Change in weekly active users, last 4 weeks vs first 4 of 12",
          pct(mean(users.slice(0, 4)), mean(users.slice(-4))),
          "bigquery:product.product_usage_weekly",
        );
      }
      if (health.length >= 2) {
        add("health.score_now", "Gainsight health score now", (health.at(-1) as { score: number }).score, "gainsight:HealthScoreHistory");
        add("health.change_12w", "Health score change over the period", (health.at(-1) as { score: number }).score - (health[0] as { score: number }).score, "gainsight:HealthScoreHistory");
      }
      const champions = contacts.filter((x) => x.Champion__c);
      add(
        "contacts.champion_left",
        "The champion has left the company",
        champions.some((x) => x.Left_Company__c === true),
        "salesforce:Contact.Left_Company__c",
      );
      const cutoff = isoDay(new Date(now.getTime() - 30 * 86_400_000));
      const recent = tickets.filter((t) => String(t.opened) >= cutoff);
      add("support.sev1_30d", "Severity-1 tickets in the last 30 days", recent.filter((t) => t.severity === "sev1").length, "bigquery:support.tickets");
      add("support.open_30d", "Tickets opened in the last 30 days that are still open", recent.filter((t) => t.status === "open").length, "bigquery:support.tickets");
      if (forecast) {
        add("forecast.close_date_pushes", "Times the renewal close date was pushed", forecast.closeDatePushes, "clari:forecast");
        add("forecast.rep_call", "Rep's forecast call", forecast.repCall, "clari:forecast");
        add("forecast.manager_call", "Manager's forecast call", forecast.managerCall, "clari:forecast");
        add("forecast.days_since_activity", "Days since the last logged customer activity", forecast.daysSinceLastActivity, "clari:forecast");
      }
      const data = {
        account: { id: acc.Id, name: acc.Name, type: acc.Type, segment: acc.Segment__c, region: acc.Region__c, ownerId: acc.OwnerId, csmId: acc.CSM__c },
        renewalOpportunityId: renewal?.Id ?? null,
        openOpportunities: opps.map((o) => ({ id: o.Id, name: o.Name, type: o.Type, stage: o.StageName, closeDate: o.CloseDate, amount: o.Amount })),
        contacts: contacts.map((x) => ({
          id: x.Id,
          name: `${x.FirstName} ${x.LastName}`,
          email: mask(String(x.Email), caller),
          title: x.Title,
          champion: x.Champion__c,
          leftCompany: x.Left_Company__c,
        })),
        facts,
      };
      return { summary: `${acc.Name}: ${facts.map((f) => `${f.label} = ${f.value}`).join("; ")}`, data };
    },
  },
  {
    name: "open_opportunities",
    title: "Open opportunities on an account",
    description: "Open opportunities for an account, with stage, close date and partner. Use to check for channel conflict.",
    scope: "gtm:read",
    write: false,
    input: { account_id: z.string().regex(/^001[A-Za-z0-9]{12,15}$/) },
    async run(a, ctx) {
      const rows = await ctx.c.salesforce.query<Rec>(
        `SELECT Id, Name, Type, StageName, CloseDate, Amount, OwnerId, Partner_Account__c FROM Opportunity WHERE AccountId = ${soqlQuote(a.account_id)} AND IsClosed = false`,
        { priority: "interactive" },
      );
      const opportunities = rows.map((o) => ({
        id: o.Id,
        name: o.Name,
        type: o.Type,
        stage: o.StageName,
        closeDate: o.CloseDate,
        amount: o.Amount,
        ownerId: o.OwnerId,
        partnerAccountId: o.Partner_Account__c,
      }));
      return { summary: `${opportunities.length} open`, data: { opportunities } };
    },
  },
  {
    name: "partner_registrations",
    title: "Deal registrations for a company",
    description: "Partner deal registrations (any status) for a company domain, to find partner-versus-partner conflicts.",
    scope: "gtm:read",
    write: false,
    input: { domain: z.string().min(3).max(120) },
    async run(a, ctx) {
      const d = a.domain.replace(/^www\./, "").toLowerCase();
      const all = [...(await ctx.c.impartner.listByStatus("Approved")), ...(await ctx.c.impartner.listByStatus("Pending"))];
      const registrations = all
        .filter((r) => r.CompanyDomain.toLowerCase() === d)
        .map((r) => ({ id: r.Id, partnerId: r.PartnerId, status: r.Status, amount: r.EstimatedAmount, submittedAt: r.SubmittedAt }));
      return { summary: `${registrations.length} registrations for ${d}`, data: { registrations } };
    },
  },
  {
    name: "sales_team",
    title: "Active members of the revenue team",
    description: "Active users by role (AE, CSM, ADR, PartnerManager, SalesOps, managers), region and segment, with their Slack ids. Use to find an owner.",
    scope: "gtm:read",
    write: false,
    input: { role: z.string().max(40).optional(), region: z.enum(["EMEA", "NA", "APAC"]).optional() },
    async run(a, ctx, caller) {
      const where = ["IsActive = true", a.role ? `Role = ${soqlQuote(a.role)}` : "", a.region ? `Region = ${soqlQuote(a.region)}` : ""].filter(Boolean).join(" AND ");
      const rows = await ctx.c.salesforce.query<Rec>(`SELECT Id, Name, Email, Role, Region, Segment__c, SlackUserId FROM User WHERE ${where} ORDER BY Name LIMIT ${ctx.maxRows}`, {
        priority: "interactive",
      });
      const users = rows.map((u) => ({ id: u.Id, name: u.Name, email: mask(String(u.Email), caller), role: u.Role, region: u.Region, segment: u.Segment__c, slackUserId: u.SlackUserId }));
      return { summary: `${users.length} people`, data: { users } };
    },
  },
  {
    name: "deal_registration",
    title: "One partner deal registration",
    description: "A deal registration from Impartner by its id (DR-...).",
    scope: "gtm:read",
    write: false,
    input: { registration_id: z.string().regex(/^DR-\d+$/) },
    async run(a, ctx) {
      const r = await ctx.c.impartner.get(a.registration_id);
      const registration = {
        id: r.Id,
        partnerId: r.PartnerId,
        companyName: r.CompanyName,
        domain: r.CompanyDomain,
        amount: r.EstimatedAmount,
        expectedCloseDate: r.ExpectedCloseDate,
        product: r.Product,
        status: r.Status,
        submittedAt: r.SubmittedAt,
        notes: r.Notes,
      };
      return { summary: `${r.Id}: ${r.CompanyName} (${r.Status})`, data: { registration } };
    },
  },
  {
    name: "renewals_due",
    title: "Open renewals closing soon",
    description: "Open renewal opportunities closing within a number of days, or one renewal by opportunity id.",
    scope: "gtm:read",
    write: false,
    input: {
      within_days: z.number().int().min(1).max(365).optional(),
      opportunity_id: z
        .string()
        .regex(/^006[A-Za-z0-9]{12,15}$/)
        .optional(),
    },
    async run(a, ctx) {
      const where = a.opportunity_id ? `Id = ${soqlQuote(a.opportunity_id)}` : `CloseDate = NEXT_N_DAYS:${a.within_days ?? 120}`;
      const rows = await ctx.c.salesforce.query<Rec>(
        `SELECT Id, AccountId, Account.Name, CloseDate, Amount, StageName FROM Opportunity WHERE Type = 'Renewal' AND IsClosed = false AND ${where} ORDER BY CloseDate LIMIT 500`,
        {
          priority: "background",
        },
      );
      const renewals = rows.map((o) => ({
        opportunityId: o.Id,
        accountId: o.AccountId,
        accountName: (o.Account as Rec | null)?.Name ?? null,
        closeDate: o.CloseDate,
        amount: o.Amount,
        stage: o.StageName,
      }));
      return { summary: `${renewals.length} renewals`, data: { renewals } };
    },
  },
  {
    name: "registrations_pending",
    title: "Pending deal registrations",
    description: "Deal registrations in Impartner that are waiting for a decision.",
    scope: "gtm:read",
    write: false,
    input: {},
    async run(_a, ctx) {
      const registrations = (await ctx.c.impartner.pending()).map((r) => ({
        id: r.Id,
        partnerId: r.PartnerId,
        companyName: r.CompanyName,
        domain: r.CompanyDomain,
        amount: r.EstimatedAmount,
        submittedAt: r.SubmittedAt,
      }));
      return { summary: `${registrations.length} pending`, data: { registrations } };
    },
  },
  {
    name: "playbook_search",
    title: "Search the GTM playbooks",
    description: "Search the company's sales, customer-success and partner playbooks. Cite passage ids when you rely on them.",
    scope: "gtm:read",
    write: false,
    input: { query: z.string().min(3).max(300), k: z.number().int().min(1).max(5).default(3) },
    async run(a, ctx) {
      const hits = ctx.playbooks.search(a.query, a.k ?? 3).map((p) => ({ id: p.id, heading: p.heading, text: p.text, score: p.score }));
      return { summary: hits.map((h) => `${h.id}: ${h.heading}`).join("; ") || "no passage matched", data: { passages: hits } };
    },
  },
  // ---- writes -------------------------------------------------------------------------------------------------------
  {
    name: "crm_upsert_lead",
    title: "Create or update a lead",
    description: "Create or update the Salesforce lead for a HubSpot submission (idempotent by submission id).",
    scope: "gtm:write",
    write: true,
    input: {
      submission_id: z.string().regex(/^hs-\d+$/),
      first_name: z.string().max(80),
      last_name: z.string().max(80),
      email: z.string().email(),
      company: z.string().max(255),
      title: z.string().max(128).optional(),
      country: z.string().max(80).optional(),
      owner_id: z.string().regex(/^005[A-Za-z0-9]{12,15}$/),
      intent: z.string().max(40),
      queue: z.string().max(80),
      matched_account_id: z
        .string()
        .regex(/^001[A-Za-z0-9]{12,15}$/)
        .nullable()
        .optional(),
      approval_token: z.string().optional(),
    },
    async run(a, ctx) {
      const r = await ctx.c.salesforce.upsert("Lead", "HubSpot_Submission_Id__c", a.submission_id, {
        FirstName: a.first_name,
        LastName: a.last_name,
        Email: a.email,
        Company: a.company,
        Title: a.title ?? null,
        Country: a.country ?? null,
        Status: "Open",
        LeadSource: "Web",
        OwnerId: a.owner_id,
        Intent__c: a.intent,
        Routing_Queue__c: a.queue,
        Matched_Account__c: a.matched_account_id ?? null,
      });
      return { summary: `lead ${r.created ? "created" : "updated"}: ${r.id}`, data: { leadId: r.id, created: r.created } };
    },
  },
  {
    name: "crm_create_task",
    title: "Create a Salesforce task",
    description: "Create a follow-up task (idempotent by external key) on an account or opportunity (what_id), or on the lead created from a HubSpot submission (lead_submission_id).",
    scope: "gtm:write",
    write: true,
    input: {
      external_key: z.string().min(6).max(120),
      what_id: z
        .string()
        .regex(/^(001|006)[A-Za-z0-9]{12,15}$/)
        .optional(),
      lead_submission_id: z
        .string()
        .regex(/^hs-\d+$/)
        .optional(),
      owner_id: z.string().regex(/^005[A-Za-z0-9]{12,15}$/),
      subject: z.string().max(255),
      description: z.string().max(4000),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      approval_token: z.string().optional(),
    },
    async run(a, ctx) {
      if (!a.what_id === !a.lead_submission_id) throw new UpstreamError("mcp", 400, "INVALID_ARGUMENT", "give exactly one of what_id and lead_submission_id", false);
      let whoId: string | null = null;
      if (a.lead_submission_id) {
        const [lead] = await ctx.c.salesforce.query<Rec>(`SELECT Id FROM Lead WHERE HubSpot_Submission_Id__c = ${soqlQuote(a.lead_submission_id)}`, { priority: "interactive" });
        if (!lead) throw new UpstreamError("mcp", 404, "NOT_FOUND", `no lead for submission ${a.lead_submission_id}`, false);
        whoId = lead.Id;
      }
      const r = await ctx.c.salesforce.upsert("Task", "External_Key__c", a.external_key, {
        WhatId: a.what_id ?? null,
        WhoId: whoId,
        OwnerId: a.owner_id,
        Subject: a.subject,
        Description: a.description,
        ActivityDate: a.due_date,
        Status: "Open",
        Priority: "Normal",
      });
      return { summary: `task ${r.id}`, data: { taskId: r.id, created: r.created } };
    },
  },
  {
    name: "cs_create_cta",
    title: "Create a Gainsight CTA",
    description: "Create a Call To Action in Gainsight Cockpit for a CSM (idempotent by reference id).",
    scope: "gtm:write",
    write: true,
    input: {
      reference_id: z.string().min(6).max(120),
      account_id: z.string().regex(/^001[A-Za-z0-9]{12,15}$/),
      owner_email: z.string().email(),
      name: z.string().max(200),
      reason: z.string().max(80),
      priority: z.enum(["High", "Medium", "Low"]),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      comments: z.string().max(4000),
      approval_token: z.string().optional(),
    },
    async run(a, ctx) {
      const r = await ctx.c.gainsight.createCta({
        referenceId: a.reference_id,
        name: a.name,
        typeName: "Risk",
        priority: a.priority,
        reason: a.reason,
        companySfdcId: a.account_id,
        ownerEmail: a.owner_email,
        dueDate: a.due_date,
        comments: a.comments,
      });
      return { summary: `CTA ${r.gsid}${r.created ? "" : " (already existed)"}`, data: r };
    },
  },
  {
    name: "seq_enroll",
    title: "Enrol a person in a Salesloft cadence",
    description: "Find or create the person in Salesloft and add them to a cadence (already enrolled counts as done).",
    scope: "gtm:write",
    write: true,
    input: {
      email: z.string().email(),
      first_name: z.string().max(80),
      last_name: z.string().max(80),
      title: z.string().max(128),
      company: z.string().max(255),
      cadence_id: z.string().max(60),
      approval_token: z.string().optional(),
    },
    async run(a, ctx) {
      const personId = await ctx.c.salesloft.findOrCreatePerson({ email: a.email, firstName: a.first_name, lastName: a.last_name, title: a.title, company: a.company });
      const r = await ctx.c.salesloft.enroll(personId, a.cadence_id);
      return { summary: r.alreadyEnrolled ? "already on the cadence" : `enrolled in ${a.cadence_id}`, data: { personId, ...r } };
    },
  },
  {
    name: "prm_decide_registration",
    title: "Decide a partner deal registration",
    description: "Approve or reject a deal registration in Impartner, with the reason the partner will see.",
    scope: "gtm:write",
    write: true,
    input: { registration_id: z.string().regex(/^DR-\d+$/), decision: z.enum(["Approved", "Rejected"]), reason: z.string().min(10).max(1000), approval_token: z.string().optional() },
    async run(a, ctx) {
      await ctx.c.impartner.decide(a.registration_id, a.decision, a.reason);
      return { summary: `${a.registration_id} ${a.decision.toLowerCase()}`, data: { registrationId: a.registration_id, decision: a.decision } };
    },
  },
  {
    name: "crm_link_partner",
    title: "Link a partner to an opportunity",
    description: "Set the Partner Account on an opportunity after an approved registration.",
    scope: "gtm:write",
    write: true,
    input: { opportunity_id: z.string().regex(/^006[A-Za-z0-9]{12,15}$/), partner_account_id: z.string().regex(/^001[A-Za-z0-9]{12,15}$/), approval_token: z.string().optional() },
    async run(a, ctx) {
      await ctx.c.salesforce.update("Opportunity", a.opportunity_id, { Partner_Account__c: a.partner_account_id });
      return { summary: `partner linked to ${a.opportunity_id}`, data: { opportunityId: a.opportunity_id } };
    },
  },
];

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs one tool for one caller: scope, argument validation, approval for writes (once per approval), audit.
 * Returns the structured result; the transport layer turns it into an MCP CallToolResult.
 */
export async function runTool(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext, caller: Caller): Promise<{ summary: string; data: Record<string, unknown> }> {
  const def = TOOLS.find((t) => t.name === name);
  const t0 = Date.now();
  const audit = (outcome: "ok" | "denied" | "error", detail: Record<string, unknown>) =>
    ctx.audit.append({
      at: ctx.clock.now().toISOString(),
      actor: `mcp:${caller.client}`,
      action: "tool.call",
      subject: `tool/${name}`,
      outcome,
      detail: { argsHash: argsHash(rawArgs), ms: Date.now() - t0, ...detail },
    });
  if (!def) {
    audit("denied", { reason: "unknown tool" });
    throw new ToolError("unknown_tool", `no tool ${name}`);
  }
  if (!caller.scopes.has(def.scope)) {
    audit("denied", { reason: `missing scope ${def.scope}` });
    throw new ToolError("forbidden", `your token does not have ${def.scope}`);
  }
  const parsed = z.object(def.input).strict().safeParse(rawArgs);
  if (!parsed.success) {
    audit("denied", { reason: "invalid arguments" });
    throw new ToolError("invalid_arguments", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  let approvedBy: string | undefined;
  if (def.write) {
    const check = verifyApproval(ctx.approvalSecret, rawArgs.approval_token as string | undefined, name, rawArgs, ctx.clock.now().getTime());
    if (!check.ok) {
      audit("denied", { reason: check.reason });
      throw new ToolError("approval_required", `${check.reason}: writes need an approval for exactly these arguments`);
    }
    approvedBy = check.claims.approvedBy;
    const previous = ctx.usedApprovals.get(check.claims.jti);
    if (previous) {
      audit("ok", { approvedBy, replay: true, instance: check.claims.instance });
      return previous as { summary: string; data: Record<string, unknown> };
    }
    try {
      const out = await def.run(parsed.data, ctx, caller);
      ctx.usedApprovals.set(check.claims.jti, out);
      audit("ok", { approvedBy, instance: check.claims.instance, resultHash: sha256(JSON.stringify(out.data)) });
      return out;
    } catch (e) {
      audit("error", { approvedBy, code: (e as UpstreamError).code ?? "error" });
      throw e;
    }
  }
  try {
    const out = await def.run(parsed.data, ctx, caller);
    audit("ok", {});
    return out;
  } catch (e) {
    audit("error", { code: (e as UpstreamError).code ?? "error" });
    throw e;
  }
}
