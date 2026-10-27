/**
 * A SOQL subset for the Salesforce emulator: enough for the queries a GTM integration really sends, parsed properly
 * rather than pattern-matched, so a malformed query fails the way Salesforce fails it (MALFORMED_QUERY).
 *
 *   SELECT field, Parent.Field, COUNT() FROM Object
 *   [WHERE cond [AND|OR cond] ... with parentheses, NOT]
 *   [ORDER BY field [ASC|DESC] [NULLS FIRST|LAST], ...] [LIMIT n] [OFFSET n]
 *
 * Conditions: = != <> < <= > >= LIKE IN NOT IN INCLUDES; literals: 'text', numbers, true/false, null, YYYY-MM-DD,
 * date-times, TODAY, YESTERDAY, LAST_N_DAYS:n, NEXT_N_DAYS:n.
 */

export class SoqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoqlError";
  }
}

type Tok = { kind: "word" | "str" | "num" | "op" | "punct"; value: string };

function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let s = "";
      i++;
      while (i < q.length && q[i] !== "'") {
        if (q[i] === "\\" && i + 1 < q.length) {
          s += q[i + 1];
          i += 2;
          continue;
        }
        s += q[i];
        i++;
      }
      if (q[i] !== "'") throw new SoqlError("unterminated string literal");
      i++;
      out.push({ kind: "str", value: s });
      continue;
    }
    const two = q.slice(i, i + 2);
    if (["<=", ">=", "!=", "<>"].includes(two)) {
      out.push({ kind: "op", value: two === "<>" ? "!=" : two });
      i += 2;
      continue;
    }
    if ("=<>".includes(c)) {
      out.push({ kind: "op", value: c });
      i++;
      continue;
    }
    if ("(),".includes(c)) {
      out.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    const m = /^[-+]?\d+(?:\.\d+)?(?:-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?)?/.exec(q.slice(i));
    if (m && /[\d-+]/.test(c) && (out.length === 0 || out.at(-1)?.kind !== "word" || /^\d/.test(c))) {
      const v = m[0];
      out.push({ kind: v.includes("-", 1) && v.length >= 10 ? "word" : "num", value: v });
      i += v.length;
      continue;
    }
    const w = /^[A-Za-z_][A-Za-z0-9_.:]*/.exec(q.slice(i));
    if (w) {
      out.push({ kind: "word", value: w[0] });
      i += w[0].length;
      continue;
    }
    throw new SoqlError(`unexpected character '${c}'`);
  }
  return out;
}

export type Cond = { op: "and"; left: Cond; right: Cond } | { op: "or"; left: Cond; right: Cond } | { op: "not"; inner: Cond } | { op: "cmp"; field: string; cmp: string; value: unknown };

export interface Query {
  fields: string[];
  count: boolean;
  object: string;
  where: Cond | null;
  orderBy: Array<{ field: string; desc: boolean; nullsLast: boolean }>;
  limit: number | null;
  offset: number;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}
  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private isWord(w: string): boolean {
    const t = this.peek();
    return !!t && t.kind === "word" && t.value.toUpperCase() === w;
  }
  private take(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new SoqlError("unexpected end of query");
    return t;
  }
  private expectWord(w: string): void {
    const t = this.take();
    if (t.kind !== "word" || t.value.toUpperCase() !== w) throw new SoqlError(`expected ${w} but found '${t.value}'`);
  }
  private expectPunct(p: string): void {
    const t = this.take();
    if (t.value !== p) throw new SoqlError(`expected '${p}' but found '${t.value}'`);
  }

  parse(): Query {
    this.expectWord("SELECT");
    const fields: string[] = [];
    let count = false;
    for (;;) {
      const t = this.take();
      if (t.kind !== "word") throw new SoqlError(`unexpected '${t.value}' in field list`);
      if (t.value.toUpperCase() === "COUNT") {
        this.expectPunct("(");
        this.expectPunct(")");
        count = true;
      } else fields.push(t.value);
      if (this.peek()?.value === ",") {
        this.take();
        continue;
      }
      break;
    }
    this.expectWord("FROM");
    const obj = this.take();
    if (obj.kind !== "word") throw new SoqlError("expected an object name after FROM");
    let where: Cond | null = null;
    if (this.isWord("WHERE")) {
      this.take();
      where = this.orExpr();
    }
    const orderBy: Query["orderBy"] = [];
    if (this.isWord("ORDER")) {
      this.take();
      this.expectWord("BY");
      for (;;) {
        const f = this.take().value;
        let desc = false;
        let nullsLast = false;
        if (this.isWord("ASC")) this.take();
        else if (this.isWord("DESC")) {
          this.take();
          desc = true;
          nullsLast = true;
        }
        if (this.isWord("NULLS")) {
          this.take();
          nullsLast = this.take().value.toUpperCase() === "LAST";
        }
        orderBy.push({ field: f, desc, nullsLast });
        if (this.peek()?.value === ",") {
          this.take();
          continue;
        }
        break;
      }
    }
    let limit: number | null = null;
    let offset = 0;
    if (this.isWord("LIMIT")) {
      this.take();
      limit = Number(this.take().value);
    }
    if (this.isWord("OFFSET")) {
      this.take();
      offset = Number(this.take().value);
    }
    if (this.peek()) throw new SoqlError(`unexpected token '${this.peek()?.value}'`);
    if (!count && fields.length === 0) throw new SoqlError("no fields selected");
    return { fields, count, object: obj.value, where, orderBy, limit, offset };
  }

  private orExpr(): Cond {
    let left = this.andExpr();
    while (this.isWord("OR")) {
      this.take();
      left = { op: "or", left, right: this.andExpr() };
    }
    return left;
  }
  private andExpr(): Cond {
    let left = this.unary();
    while (this.isWord("AND")) {
      this.take();
      left = { op: "and", left, right: this.unary() };
    }
    return left;
  }
  private unary(): Cond {
    if (this.isWord("NOT")) {
      this.take();
      return { op: "not", inner: this.unary() };
    }
    if (this.peek()?.value === "(") {
      this.take();
      const c = this.orExpr();
      this.expectPunct(")");
      return c;
    }
    const field = this.take();
    if (field.kind !== "word") throw new SoqlError(`expected a field name, found '${field.value}'`);
    let cmp: string;
    const t = this.take();
    if (t.kind === "op") cmp = t.value;
    else if (t.kind === "word" && ["LIKE", "IN", "INCLUDES", "EXCLUDES"].includes(t.value.toUpperCase())) cmp = t.value.toUpperCase();
    else if (t.kind === "word" && t.value.toUpperCase() === "NOT" && this.isWord("IN")) {
      this.take();
      cmp = "NOT IN";
    } else throw new SoqlError(`expected an operator after ${field.value}, found '${t.value}'`);
    let value: unknown;
    if (cmp === "IN" || cmp === "NOT IN" || cmp === "INCLUDES" || cmp === "EXCLUDES") {
      this.expectPunct("(");
      const vals: unknown[] = [];
      for (;;) {
        vals.push(this.literal());
        if (this.peek()?.value === ",") {
          this.take();
          continue;
        }
        break;
      }
      this.expectPunct(")");
      value = vals;
    } else value = this.literal();
    return { op: "cmp", field: field.value, cmp, value };
  }
  private literal(): unknown {
    const t = this.take();
    if (t.kind === "str") return t.value;
    if (t.kind === "num") return Number(t.value);
    if (t.kind === "word") {
      const u = t.value.toUpperCase();
      if (u === "TRUE") return true;
      if (u === "FALSE") return false;
      if (u === "NULL") return null;
      if (/^\d{4}-\d{2}-\d{2}/.test(t.value)) return { date: t.value };
      if (/^(TODAY|YESTERDAY|TOMORROW|LAST_N_DAYS:\d+|NEXT_N_DAYS:\d+)$/.test(u)) return { dateLiteral: u };
    }
    throw new SoqlError(`unexpected value '${t.value}'`);
  }
}

export function parseSoql(q: string): Query {
  return new Parser(tokenize(q)).parse();
}

type Row = Record<string, unknown>;
export type Resolver = (row: Row, path: string) => unknown;

function dateRange(lit: string, today: Date): [number, number] {
  const day = 86_400_000;
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (lit === "TODAY") return [t0, t0 + day];
  if (lit === "YESTERDAY") return [t0 - day, t0];
  if (lit === "TOMORROW") return [t0 + day, t0 + 2 * day];
  const n = Number(lit.split(":")[1]);
  if (lit.startsWith("LAST_N_DAYS")) return [t0 - n * day, t0 + day];
  return [t0, t0 + (n + 1) * day];
}

function cmpValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function matches(c: Cond, row: Row, get: Resolver, today: Date): boolean {
  if (c.op === "and" || c.op === "or") {
    return c.op === "and" ? matches(c.left, row, get, today) && matches(c.right, row, get, today) : matches(c.left, row, get, today) || matches(c.right, row, get, today);
  }
  if (c.op === "not") return !matches(c.inner, row, get, today);
  const v = get(row, c.field);
  const target = c.value as unknown;
  if (target && typeof target === "object" && !Array.isArray(target) && "dateLiteral" in target) {
    if (v === null || v === undefined) return c.cmp === "!=";
    const t = new Date(String(v)).getTime();
    const [lo, hi] = dateRange((target as { dateLiteral: string }).dateLiteral, today);
    switch (c.cmp) {
      case "=":
        return t >= lo && t < hi;
      case "!=":
        return t < lo || t >= hi;
      case "<":
        return t < lo;
      case "<=":
        return t < hi;
      case ">":
        return t >= hi;
      case ">=":
        return t >= lo;
      default:
        throw new SoqlError(`operator ${c.cmp} is not valid for a date literal`);
    }
  }
  const val = target && typeof target === "object" && !Array.isArray(target) && "date" in target ? (target as { date: string }).date : target;
  switch (c.cmp) {
    case "=":
      return val === null ? v === null || v === undefined : typeof v === "string" && typeof val === "string" ? v.toLowerCase() === val.toLowerCase() : v === val;
    case "!=":
      return val === null ? v !== null && v !== undefined : !(typeof v === "string" && typeof val === "string" ? v.toLowerCase() === val.toLowerCase() : v === val);
    case "<":
      return v !== null && v !== undefined && cmpValues(v, val) < 0;
    case "<=":
      return v !== null && v !== undefined && cmpValues(v, val) <= 0;
    case ">":
      return v !== null && v !== undefined && cmpValues(v, val) > 0;
    case ">=":
      return v !== null && v !== undefined && cmpValues(v, val) >= 0;
    case "LIKE": {
      const re = new RegExp(
        `^${String(val)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/%/g, ".*")
          .replace(/_/g, ".")}$`,
        "i",
      );
      return typeof v === "string" && re.test(v);
    }
    case "IN":
      return (val as unknown[]).some((x) => (typeof v === "string" && typeof x === "string" ? v.toLowerCase() === x.toLowerCase() : v === x));
    case "NOT IN":
      return !(val as unknown[]).some((x) => (typeof v === "string" && typeof x === "string" ? v.toLowerCase() === x.toLowerCase() : v === x));
    default:
      throw new SoqlError(`operator ${c.cmp} is not supported`);
  }
}

export function execute(q: Query, rows: Row[], get: Resolver, today: Date): { rows: Row[]; total: number } {
  let out = q.where ? rows.filter((r) => matches(q.where as Cond, r, get, today)) : [...rows];
  if (q.orderBy.length) {
    out.sort((a, b) => {
      for (const o of q.orderBy) {
        const x = get(a, o.field);
        const y = get(b, o.field);
        const xn = x === null || x === undefined;
        const yn = y === null || y === undefined;
        if (xn !== yn) return (xn ? 1 : -1) * (o.nullsLast ? 1 : -1);
        const d = cmpValues(x, y);
        if (d !== 0) return o.desc ? -d : d;
      }
      return 0;
    });
  }
  const total = out.length;
  out = out.slice(q.offset, q.limit === null ? undefined : q.offset + q.limit);
  return { rows: out, total: q.limit === null ? total : Math.min(total - q.offset, q.limit) };
}
