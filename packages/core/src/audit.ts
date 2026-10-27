import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, sha256 } from "./crypto";

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string; // service or person
  action: string; // "tool.call", "approval.granted", "process.started" ...
  subject: string; // "process/123", "tool/crm_create_task"
  outcome: "ok" | "denied" | "error" | "pending";
  detail: Record<string, unknown>; // ids, hashes, statuses; never free text from documents or emails
  prev: string;
  hash: string;
}

export interface AuditSink {
  write(e: AuditEntry): void | Promise<void>;
}

/**
 * Append-only, hash-chained audit log. Every entry commits to the previous one, so removing or editing an entry
 * breaks verification. Entries are mirrored to sinks (BigQuery in production) after they are written locally.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private sinks: AuditSink[] = [];

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      this.entries = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEntry);
    }
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  addSink(s: AuditSink): void {
    this.sinks.push(s);
  }

  append(e: Omit<AuditEntry, "seq" | "prev" | "hash" | "at"> & { at?: string }): AuditEntry {
    const prev = this.entries.at(-1)?.hash ?? "genesis";
    const body = { ...e, at: e.at ?? new Date().toISOString(), seq: this.entries.length + 1, prev };
    const entry: AuditEntry = { ...body, hash: sha256(prev + canonical(body)) };
    this.entries.push(entry);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    for (const s of this.sinks) void Promise.resolve(s.write(entry)).catch(() => undefined);
    return entry;
  }

  list(filter: (e: AuditEntry) => boolean = () => true, limit = 200): AuditEntry[] {
    return this.entries.filter(filter).slice(-limit).reverse();
  }

  verify(): { intact: boolean; entries: number; brokenAt?: number } {
    let prev = "genesis";
    for (const e of this.entries) {
      const { hash, ...body } = e;
      if (body.prev !== prev || sha256(prev + canonical(body)) !== hash) return { intact: false, entries: this.entries.length, brokenAt: e.seq };
      prev = hash;
    }
    return { intact: true, entries: this.entries.length };
  }
}
