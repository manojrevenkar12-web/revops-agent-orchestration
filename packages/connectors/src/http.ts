/**
 * HTTP for connectors: timeouts, retries with full jitter on transient failures only, Retry-After, and a circuit
 * breaker per upstream so a failing system fails fast instead of holding every process instance on a timeout.
 */

export class UpstreamError extends Error {
  constructor(
    readonly system: string,
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${system}: ${code}: ${message}`);
    this.name = "UpstreamError";
  }
}

export interface RetryPolicy {
  attempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseMs: 200, maxMs: 4000 };

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(
    readonly name: string,
    private readonly threshold = 5,
    private readonly coolDownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}
  get state(): "closed" | "open" | "half-open" {
    if (this.failures < this.threshold) return "closed";
    return this.now() - this.openedAt >= this.coolDownMs ? "half-open" : "open";
  }
  before(): void {
    if (this.state === "open") throw new UpstreamError(this.name, 503, "CIRCUIT_OPEN", "too many recent failures; failing fast", true);
  }
  success(): void {
    this.failures = 0;
  }
  failure(): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

export interface CallStats {
  system: string;
  status: number;
  ms: number;
  attempts: number;
}

/** Runs fn with retries; fn throws UpstreamError with `retryable` to say whether another attempt can help. */
export async function withRetry<T>(
  system: string,
  fn: (attempt: number) => Promise<T>,
  opts: { policy?: RetryPolicy; breaker?: CircuitBreaker; sleep?: Sleep; onCall?: (s: CallStats) => void } = {},
): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY;
  const sleep = opts.sleep ?? realSleep;
  const t0 = Date.now();
  let last: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    opts.breaker?.before();
    try {
      const out = await fn(attempt);
      opts.breaker?.success();
      opts.onCall?.({ system, status: 200, ms: Date.now() - t0, attempts: attempt });
      return out;
    } catch (e) {
      last = e;
      const err = e instanceof UpstreamError ? e : new UpstreamError(system, 0, "NETWORK", String((e as Error).message ?? e), true);
      if (err.retryable) opts.breaker?.failure();
      if (!err.retryable || attempt === policy.attempts) {
        opts.onCall?.({ system, status: err.status, ms: Date.now() - t0, attempts: attempt });
        throw err;
      }
      const retryAfter = (err as UpstreamError & { retryAfterMs?: number }).retryAfterMs;
      const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
      await sleep(retryAfter ?? Math.random() * backoff);
    }
  }
  throw last;
}

export async function fetchJson<T>(system: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new UpstreamError(system, 0, (e as Error).name === "AbortError" ? "TIMEOUT" : "NETWORK", (e as Error).message, true);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    const err = new UpstreamError(system, res.status, `HTTP_${res.status}`, typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 300), retryable);
    const ra = res.headers.get("retry-after");
    if (ra) (err as UpstreamError & { retryAfterMs?: number }).retryAfterMs = Math.min(60_000, Number(ra) * 1000);
    (err as UpstreamError & { body?: unknown }).body = data;
    throw err;
  }
  return { data: data as T, headers: res.headers, status: res.status };
}
