/**
 * Invariants that keep the evaluation honest and the platform governed:
 * - shipping code never reads the sandbox truth (only evals/ and tests do);
 * - workers reach GTM systems only through the MCP server (no Salesforce, Gainsight, Salesloft or Impartner client
 *   in the workers), except the CDC stream, which is read-only;
 * - held-out first runs are never rewritten (their hashes are pinned in reports/heldout/PINS).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@revops/core";
import { describe, expect, it } from "vitest";

const root = repoRoot();
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "node_modules" || f === "dist" || f === "__pycache__" ? [] : walk(p)) : [p];
  });
const shipping = [
  ...["core", "connectors", "mcp-server", "engine", "orchestrator"].flatMap((p) => walk(join(root, "packages", p, "src"))).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")),
  ...walk(join(root, "agent", "revops_agent")).filter((f) => f.endsWith(".py")),
];

describe("isolation", () => {
  it("no shipping code mentions the truth", () => {
    const offenders = shipping.filter((f) => /\btruth\b|_sandbox\/truth/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("workers use the MCP server for every GTM read and write", () => {
    const workers = readFileSync(join(root, "packages", "orchestrator", "src", "workers.ts"), "utf8");
    expect(workers).not.toMatch(/\.(salesforce|gainsight|salesloft|impartner|clari)\./);
    expect(workers).not.toMatch(/from "@revops\/connectors".*Salesforce/);
  });

  it("held-out first runs match their pinned hashes", () => {
    const pins = join(root, "reports", "heldout", "PINS");
    if (!existsSync(pins)) return;
    for (const line of readFileSync(pins, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))) {
      const [hash, file] = line.trim().split(/\s+/);
      expect(
        createHash("sha256")
          .update(readFileSync(join(root, file as string)))
          .digest("hex"),
        file,
      ).toBe(hash);
    }
  });
});
