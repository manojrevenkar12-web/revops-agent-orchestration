import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/** The repository root: REVOPS_ROOT, or the nearest directory above this file that holds config/. */
export function repoRoot(): string {
  if (process.env.REVOPS_ROOT) return resolve(process.env.REVOPS_ROOT);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "config", "automations.yaml"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const cache = new Map<string, { mtime: number; value: unknown }>();

/** Expand ${VAR} and ${VAR:-default} in strings loaded from config. */
export function expand(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => process.env[name] ?? def ?? "");
}

function expandDeep(v: unknown): unknown {
  if (typeof v === "string") return expand(v);
  if (Array.isArray(v)) return v.map(expandDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x)]));
  return v;
}

/** Load config/<name>.yaml (cached by modification time). Settings live in config/, never in code. */
export function loadConfig<T = Record<string, unknown>>(name: string): T {
  const path = join(repoRoot(), "config", `${name}.yaml`);
  const mtime = statSync(path).mtimeMs;
  const hit = cache.get(path);
  if (hit && hit.mtime === mtime) return hit.value as T;
  const value = expandDeep(parse(readFileSync(path, "utf8")));
  cache.set(path, { mtime, value });
  return value as T;
}

export function readRepoFile(...parts: string[]): string {
  return readFileSync(join(repoRoot(), ...parts), "utf8");
}
