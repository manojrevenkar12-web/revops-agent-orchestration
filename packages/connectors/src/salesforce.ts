/**
 * Salesforce REST and Bulk API 2.0 client for the automation layer.
 *
 * - **API budget.** Every response carries Sforce-Limit-Info (api-usage=used/max). The client keeps a share of the
 *   org's daily allowance in reserve for people and other integrations: background work stops at the soft reserve,
 *   interactive work (a person is waiting) at the hard reserve. Running out of API calls at 3 pm stops the whole
 *   revenue team, so the automation layer is the one that yields.
 * - **Retries** only for what another attempt can fix: 503, UNABLE_TO_LOCK_ROW, network errors. A validation error
 *   is returned to the caller at once.
 * - **Large reads** go through Bulk API 2.0 (one job instead of hundreds of REST pages), paged by Sforce-Locator.
 * - **Writes** are upserts by external ID wherever a retry could repeat them, so a retried write cannot duplicate a
 *   Lead or a Task.
 */
import { CircuitBreaker, type Sleep, UpstreamError, fetchJson, withRetry } from "./http";

export interface SalesforceConfig {
  loginUrl: string; // https://login.salesforce.com or the sandbox
  clientId: string;
  clientSecret: string;
  apiVersion: string; // "v62.0"
  softReservePct: number; // background work stops when less than this share remains
  hardReservePct: number; // interactive work stops here
  bulkThreshold: number; // expected rows above which reads use Bulk API 2.0
}

export type Priority = "interactive" | "background";

const TRANSIENT_CODES = new Set(["UNABLE_TO_LOCK_ROW", "SERVER_UNAVAILABLE", "REQUEST_RUNNING_TOO_LONG"]);

export interface SfRecord {
  Id: string;
  [field: string]: unknown;
}

export class BudgetExhausted extends UpstreamError {
  constructor(used: number, max: number, priority: Priority) {
    super("salesforce", 429, "API_BUDGET_RESERVED", `${priority} work paused: ${used}/${max} daily API calls used, the rest is reserved`, false);
  }
}

export class SalesforceClient {
  private token: string | null = null;
  private instanceUrl = "";
  used = 0;
  max = Number.POSITIVE_INFINITY;
  readonly breaker = new CircuitBreaker("salesforce", 5, 30_000);

  constructor(
    private readonly cfg: SalesforceConfig,
    private readonly sleep?: Sleep,
  ) {}

  get budget(): { used: number; max: number; remainingPct: number } {
    return { used: this.used, max: this.max, remainingPct: Number.isFinite(this.max) ? Math.max(0, 1 - this.used / this.max) * 100 : 100 };
  }

  private async login(): Promise<void> {
    const { data } = await fetchJson<{ access_token: string; instance_url: string }>("salesforce", `${this.cfg.loginUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
    });
    this.token = data.access_token;
    this.instanceUrl = data.instance_url;
  }

  private guard(priority: Priority): void {
    if (!Number.isFinite(this.max)) return;
    const remainingPct = (1 - this.used / this.max) * 100;
    const floor = priority === "background" ? this.cfg.softReservePct : this.cfg.hardReservePct;
    if (remainingPct <= floor) throw new BudgetExhausted(this.used, this.max, priority);
  }

  private track(headers: Headers): void {
    const m = /api-usage=(\d+)\/(\d+)/.exec(headers.get("sforce-limit-info") ?? "");
    if (m) {
      this.used = Number(m[1]);
      this.max = Number(m[2]);
    }
  }

  /** One REST call with authentication, budget, retries and Salesforce's error format mapped to UpstreamError. */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; priority?: Priority; headers?: Record<string, string>; raw?: boolean } = {},
  ): Promise<{ data: T; headers: Headers; status: number }> {
    const priority = opts.priority ?? "background";
    return withRetry(
      "salesforce",
      async () => {
        this.guard(priority);
        if (!this.token) await this.login();
        const url = path.startsWith("http") ? path : `${this.instanceUrl}${path}`;
        const res = await fetch(url, {
          method,
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: opts.raw ? "text/csv" : "application/json", ...opts.headers },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        }).catch((e: Error) => {
          throw new UpstreamError("salesforce", 0, "NETWORK", e.message, true);
        });
        this.track(res.headers);
        const text = await res.text();
        if (res.status === 401) {
          this.token = null;
          throw new UpstreamError("salesforce", 401, "INVALID_SESSION_ID", "session expired; logging in again", true);
        }
        if (!res.ok) {
          let code = `HTTP_${res.status}`;
          let message = text.slice(0, 300);
          try {
            const j = JSON.parse(text) as Array<{ errorCode: string; message: string }>;
            if (Array.isArray(j) && j[0]) ({ errorCode: code, message } = j[0]);
          } catch {
            /* not JSON */
          }
          throw new UpstreamError("salesforce", res.status, code, message, res.status >= 500 || TRANSIENT_CODES.has(code));
        }
        const data = (opts.raw ? text : text ? JSON.parse(text) : null) as T;
        return { data, headers: res.headers, status: res.status };
      },
      { breaker: this.breaker, sleep: this.sleep },
    );
  }

  /** SOQL with paging. Values interpolated into SOQL must go through `soqlQuote`. */
  async query<T extends SfRecord>(soql: string, opts: { priority?: Priority; max?: number } = {}): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `/services/data/${this.cfg.apiVersion}/query?q=${encodeURIComponent(soql)}`;
    while (next && out.length < (opts.max ?? 50_000)) {
      const page: { data: { records: T[]; nextRecordsUrl?: string; done: boolean } } = await this.request<{ records: T[]; nextRecordsUrl?: string; done: boolean }>("GET", next, {
        priority: opts.priority,
      });
      const data = page.data;
      out.push(...data.records);
      next = data.done ? null : (data.nextRecordsUrl ?? null);
    }
    return out.slice(0, opts.max ?? 50_000);
  }

  /** Bulk API 2.0 query: create the job, poll until complete, read CSV pages by locator. */
  async bulkQuery(soql: string, opts: { pollMs?: number; maxPolls?: number } = {}): Promise<Array<Record<string, string>>> {
    const base = `/services/data/${this.cfg.apiVersion}/jobs/query`;
    const { data: job } = await this.request<{ id: string }>("POST", base, { body: { operation: "query", query: soql } });
    for (let i = 0; ; i++) {
      const { data: st } = await this.request<{ state: string; errorMessage?: string }>("GET", `${base}/${job.id}`);
      if (st.state === "JobComplete") break;
      if (st.state === "Failed" || st.state === "Aborted") throw new UpstreamError("salesforce", 400, "BULK_JOB_FAILED", st.errorMessage ?? st.state, false);
      if (i >= (opts.maxPolls ?? 120)) throw new UpstreamError("salesforce", 504, "BULK_TIMEOUT", "bulk job did not complete", true);
      await (this.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(opts.pollMs ?? 2000);
    }
    const rows: Array<Record<string, string>> = [];
    let locator: string | null = null;
    do {
      const q: string = locator ? `?locator=${encodeURIComponent(locator)}&maxRecords=50000` : "?maxRecords=50000";
      const { data, headers } = await this.request<string>("GET", `${base}/${job.id}/results${q}`, { raw: true });
      rows.push(...parseCsv(data));
      const l = headers.get("sforce-locator");
      locator = l && l !== "null" ? l : null;
    } while (locator);
    return rows;
  }

  async retrieve<T extends SfRecord>(object: string, id: string, fields: string[], priority: Priority = "interactive"): Promise<T> {
    const { data } = await this.request<T>("GET", `/services/data/${this.cfg.apiVersion}/sobjects/${object}/${encodeURIComponent(id)}?fields=${fields.join(",")}`, { priority });
    return data;
  }

  /** Idempotent write: the external ID makes a retried or replayed call update instead of duplicate. */
  async upsert(object: string, externalField: string, externalId: string, body: Record<string, unknown>): Promise<{ id: string; created: boolean }> {
    const { data } = await this.request<{ id: string; created: boolean }>("PATCH", `/services/data/${this.cfg.apiVersion}/sobjects/${object}/${externalField}/${encodeURIComponent(externalId)}`, {
      body,
    });
    return data;
  }

  async update(object: string, id: string, body: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `/services/data/${this.cfg.apiVersion}/sobjects/${object}/${encodeURIComponent(id)}`, { body });
  }

  async limits(): Promise<{ DailyApiRequests: { Max: number; Remaining: number } }> {
    const { data } = await this.request<{ DailyApiRequests: { Max: number; Remaining: number } }>("GET", `/services/data/${this.cfg.apiVersion}/limits`, { priority: "interactive" });
    this.max = data.DailyApiRequests.Max;
    this.used = data.DailyApiRequests.Max - data.DailyApiRequests.Remaining;
    return data;
  }
}

/** Quote a value for SOQL: escape backslashes and quotes so input cannot change the query. */
export function soqlQuote(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
