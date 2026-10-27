/**
 * FEEL as Zeebe uses it: a value starting with "=" is an expression, anything else is a static value. Evaluation
 * uses feelin with Zeebe's extension functions (`is defined`, `get or else`, `fromAi`) and the engine clock for
 * `now()` and `today()`, so timers and expressions agree in tests that move time.
 *
 * Strictness differs by use: a missing variable in an input mapping is null (as in Zeebe), but a condition or a
 * required expression that cannot be evaluated raises an incident instead of quietly taking a path.
 */
import { evaluate as feelEvaluate, unaryTest as feelUnaryTest } from "feelin";

export class FeelError extends Error {
  constructor(
    readonly expression: string,
    message: string,
  ) {
    super(`${message} in '${expression}'`);
  }
}

export interface FeelEnv {
  now: () => Date;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** feelin reads parameter names from a function's source, which bundlers rewrite; name them explicitly. */
function named<F extends (...a: never[]) => unknown>(args: string[], fn: F): F {
  (fn as unknown as { $args: string[] }).$args = args;
  return fn;
}

function extensions(env: FeelEnv): Record<string, unknown> {
  return {
    "is defined": named(["value"], (value: unknown) => value !== null && value !== undefined),
    "get or else": named(["value", "default"], (value: unknown, otherwise: unknown) => (value === null || value === undefined ? otherwise : value)),
    // In the engine, fromAi just reads the value the agent supplied; the parameter list is derived from the model.
    fromAi: named(["value", "description", "type", "schema"], (value: unknown) => value ?? null),
    now: named([], () => env.now().toISOString()),
    today: named([], () => {
      const d = env.now();
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }),
  };
}

/** Convert feelin's temporal and number values into JSON. */
function toJson(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toJson);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return typeof (v as { toString?: () => string }).toString === "function" ? String(v) : v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]));
}

export const isExpression = (s: string | undefined): s is string => typeof s === "string" && s.trim().startsWith("=");

/** Evaluate a FEEL expression (without the leading "="). strict: warnings other than missing variables are errors. */
export function evalFeel(expression: string, context: Record<string, unknown>, env: FeelEnv, opts: { strict?: boolean } = {}): unknown {
  const expr = expression.trim().replace(/^=/, "");
  let result: { value: unknown; warnings: Array<{ type: string; message: string }> };
  try {
    result = feelEvaluate(expr, { ...context, ...extensions(env) }) as typeof result;
  } catch (e) {
    throw new FeelError(expr, `FEEL syntax error: ${(e as Error).message}`);
  }
  if (opts.strict) {
    const serious = result.warnings.find((w) => w.type !== "NO_VARIABLE_FOUND" && w.type !== "NO_PROPERTY_FOUND" && w.type !== "NO_CONTEXT_ENTRY_FOUND");
    if (serious) throw new FeelError(expr, serious.message);
  }
  return toJson(result.value);
}

/** A Zeebe property value: "=expr" is evaluated, anything else is the literal string. */
export function feelValue(raw: string | undefined, context: Record<string, unknown>, env: FeelEnv): unknown {
  if (raw === undefined) return undefined;
  return isExpression(raw) ? evalFeel(raw, context, env) : raw;
}

/** A condition: must evaluate to a boolean. null (for example, a missing variable) counts as false, like Zeebe. */
export function condition(expression: string, context: Record<string, unknown>, env: FeelEnv): boolean {
  const v = evalFeel(expression, context, env, { strict: true });
  if (v === null) return false;
  if (typeof v !== "boolean") throw new FeelError(expression, `expected a boolean but got ${JSON.stringify(v)}`);
  return v;
}

export function unaryTest(test: string, input: unknown, context: Record<string, unknown>, env: FeelEnv): boolean {
  const t = test.trim();
  if (t === "" || t === "-") return true;
  try {
    const r = feelUnaryTest(t, { ...context, ...extensions(env), "?": input }) as { value: boolean | null };
    return r.value === true;
  } catch (e) {
    throw new FeelError(t, `FEEL syntax error: ${(e as Error).message}`);
  }
}

/** ISO 8601 durations and dates for timers: "PT15M", "P2D", "2026-11-01T09:00:00Z", "R3/PT1H". */
export function parseIsoDuration(s: string): number {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m || s.trim() === "P" || s.trim().endsWith("T")) throw new FeelError(s, "not an ISO 8601 duration");
  const [, y, mo, w, d, h, mi, sec] = m.map((x) => (x ? Number(x) : 0)) as number[];
  return (((((y as number) * 365 + (mo as number) * 30 + (w as number) * 7 + (d as number)) * 24 + (h as number)) * 60 + (mi as number)) * 60 + (sec as number)) * 1000;
}

export function parseCycle(s: string): { repetitions: number | null; intervalMs: number } {
  const m = /^R(\d*)\/(P.+)$/.exec(s.trim());
  if (!m) throw new FeelError(s, "not an ISO 8601 repeating interval (R<n>/<duration>)");
  return { repetitions: m[1] ? Number(m[1]) : null, intervalMs: parseIsoDuration(m[2] as string) };
}
