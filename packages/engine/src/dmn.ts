/**
 * DMN 1.3 decision tables and literal expressions, as Zeebe evaluates them for business rule tasks. Required
 * decisions are evaluated first and their results are available by decision id. Hit policies: UNIQUE, FIRST, ANY,
 * PRIORITY, RULE ORDER and COLLECT (with SUM, MIN, MAX, COUNT).
 *
 * Every evaluation returns which rules matched, so a routing decision can be explained ("rule 4: enterprise
 * prospect asking for a demo") and audited.
 */
import DmnModdle from "dmn-moddle";
import { evalFeel, type FeelEnv, unaryTest } from "./feel";

export interface DecisionTable {
  kind: "table";
  hitPolicy: "UNIQUE" | "FIRST" | "ANY" | "PRIORITY" | "RULE ORDER" | "COLLECT" | "OUTPUT ORDER";
  aggregation?: "SUM" | "MIN" | "MAX" | "COUNT";
  inputs: Array<{ label: string; expression: string }>;
  outputs: Array<{ name: string; label: string; values: string[] }>;
  rules: Array<{ id: string; description: string; inputs: string[]; outputs: string[] }>;
}

export interface DecisionDef {
  decisionId: string;
  name: string;
  requires: string[];
  logic: DecisionTable | { kind: "literal"; expression: string; variable: string };
  drgId: string;
  version: number;
  key: string;
  resourceName: string;
  xml: string;
}

export interface DecisionResult {
  decisionId: string;
  output: unknown;
  matchedRules: Array<{ ruleId: string; ruleIndex: number; description: string }>;
  evaluated: Array<{ decisionId: string; output: unknown; matchedRules: number[] }>;
}

export class DecisionError extends Error {}

// biome-ignore lint/suspicious/noExplicitAny: moddle elements are dynamically typed
type Moddle = any;

export async function parseDmn(xml: string, resourceName: string): Promise<Array<Omit<DecisionDef, "version" | "key">>> {
  const { rootElement: root, warnings } = await new DmnModdle().fromXML(xml, "dmn:Definitions");
  if (warnings.length) throw new DecisionError(`${resourceName}: ${(warnings as Array<{ message: string }>).map((w) => w.message.split("\n")[0]).join("; ")}`);
  const out: Array<Omit<DecisionDef, "version" | "key">> = [];
  for (const d of (root.drgElement ?? []).filter((x: Moddle) => x.$type === "dmn:Decision")) {
    const logic = d.decisionLogic;
    const requires = (d.informationRequirement ?? []).map((r: Moddle) => r.requiredDecision?.href?.replace(/^#/, "")).filter(Boolean);
    if (logic?.$type === "dmn:DecisionTable") {
      const table: DecisionTable = {
        kind: "table",
        hitPolicy: (logic.hitPolicy ?? "UNIQUE").replace("_", " ") as DecisionTable["hitPolicy"],
        aggregation: logic.aggregation,
        inputs: (logic.input ?? []).map((i: Moddle) => ({ label: i.label ?? "", expression: i.inputExpression?.text ?? "" })),
        outputs: (logic.output ?? []).map((o: Moddle) => ({
          name: o.name ?? "",
          label: o.label ?? "",
          values: (o.outputValues?.text ?? "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        })),
        rules: (logic.rule ?? []).map((r: Moddle) => ({
          id: r.id,
          description: r.description ?? "",
          inputs: (r.inputEntry ?? []).map((e: Moddle) => e.text ?? "-"),
          outputs: (r.outputEntry ?? []).map((e: Moddle) => e.text ?? ""),
        })),
      };
      if (table.outputs.length > 1 && table.outputs.some((o) => !o.name)) throw new DecisionError(`${d.id}: outputs of a multi-output table need names`);
      out.push({ decisionId: d.id, name: d.name ?? d.id, requires, logic: table, drgId: root.id, resourceName, xml });
    } else if (logic?.$type === "dmn:LiteralExpression") {
      out.push({ decisionId: d.id, name: d.name ?? d.id, requires, logic: { kind: "literal", expression: logic.text ?? "", variable: d.variable?.name ?? d.id }, drgId: root.id, resourceName, xml });
    } else {
      throw new DecisionError(`${d.id}: only decision tables and literal expressions are supported`);
    }
  }
  return out;
}

export function evaluateDecision(id: string, lookup: (id: string) => DecisionDef | undefined, variables: Record<string, unknown>, env: FeelEnv): DecisionResult {
  const evaluated: DecisionResult["evaluated"] = [];
  const results = new Map<string, { output: unknown; matched: Array<{ ruleId: string; ruleIndex: number; description: string }> }>();
  const visit = (did: string, stack: string[]): unknown => {
    if (results.has(did)) return results.get(did)?.output;
    if (stack.includes(did)) throw new DecisionError(`cyclic decision requirements: ${[...stack, did].join(" -> ")}`);
    const d = lookup(did);
    if (!d) throw new DecisionError(`no decision ${did} is deployed`);
    const ctx: Record<string, unknown> = { ...variables };
    for (const r of d.requires) ctx[r] = visit(r, [...stack, did]);
    const r = d.logic.kind === "literal" ? { output: evalFeel(d.logic.expression, ctx, env, { strict: true }), matched: [] } : evalTable(d, ctx, env);
    results.set(did, r);
    evaluated.push({ decisionId: did, output: r.output, matchedRules: r.matched.map((m) => m.ruleIndex) });
    return r.output;
  };
  const output = visit(id, []);
  return { decisionId: id, output, matchedRules: results.get(id)?.matched ?? [], evaluated };
}

function evalTable(d: DecisionDef, ctx: Record<string, unknown>, env: FeelEnv) {
  const t = d.logic as DecisionTable;
  const inputValues = t.inputs.map((i) => evalFeel(i.expression, ctx, env, { strict: true }));
  const matched: Array<{ ruleId: string; ruleIndex: number; description: string; output: unknown }> = [];
  t.rules.forEach((rule, idx) => {
    const ok = rule.inputs.every((test, i) => unaryTest(test, inputValues[i], ctx, env));
    if (!ok) return;
    const values = rule.outputs.map((o) => (o.trim() === "" ? null : evalFeel(o, ctx, env, { strict: true })));
    const output = t.outputs.length === 1 && !t.outputs[0]?.name ? values[0] : Object.fromEntries(t.outputs.map((o, i) => [o.name, values[i] ?? null]));
    matched.push({ ruleId: rule.id, ruleIndex: idx + 1, description: rule.description, output });
  });
  const strip = (m: (typeof matched)[number]) => ({ ruleId: m.ruleId, ruleIndex: m.ruleIndex, description: m.description });
  const single = (m: (typeof matched)[number] | undefined) => ({ output: m?.output ?? null, matched: m ? [strip(m)] : [] });
  switch (t.hitPolicy) {
    case "UNIQUE":
      if (matched.length > 1) throw new DecisionError(`${d.decisionId}: UNIQUE hit policy but rules ${matched.map((m) => m.ruleIndex).join(", ")} all match`);
      return single(matched[0]);
    case "FIRST":
      return single(matched[0]);
    case "ANY": {
      const distinct = new Set(matched.map((m) => JSON.stringify(m.output)));
      if (distinct.size > 1) throw new DecisionError(`${d.decisionId}: ANY hit policy but matching rules disagree`);
      return single(matched[0]);
    }
    case "PRIORITY": {
      const out = t.outputs[0];
      const rank = (m: (typeof matched)[number]) => {
        const v = JSON.stringify(t.outputs.length === 1 && !out?.name ? m.output : (m.output as Record<string, unknown>)[out?.name ?? ""]);
        const i = (out?.values ?? []).indexOf(v);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      return single([...matched].sort((a, b) => rank(a) - rank(b))[0]);
    }
    case "COLLECT": {
      const outs = matched.map((m) => m.output);
      if (!t.aggregation) return { output: outs, matched: matched.map(strip) };
      const nums = outs.map(Number);
      const agg = { SUM: nums.reduce((a, b) => a + b, 0), MIN: nums.length ? Math.min(...nums) : null, MAX: nums.length ? Math.max(...nums) : null, COUNT: nums.length }[t.aggregation];
      return { output: agg, matched: matched.map(strip) };
    }
    default:
      return { output: matched.map((m) => m.output), matched: matched.map(strip) };
  }
}
