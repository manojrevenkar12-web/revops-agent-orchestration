/**
 * Audit entries leave the process in batches for BigQuery (revops_audit.events, partitioned by day). The insert id
 * is the entry's hash, so a retried batch is not stored twice. Each Cloud Run instance writes its own hash chain,
 * identified by `writer`; a chain is verified per writer (sql/audit_chain_check.sql).
 *
 * Shipping is best-effort with a bounded buffer: an audit backlog must not take the automations down, and the
 * console shows when entries are waiting to be shipped.
 */
import { randomId } from "@revops/core";
import type { AuditEntry, AuditSink } from "@revops/core";
import type { Warehouse } from "./gtm";

export class BigQueryAuditSink implements AuditSink {
  private buffer: AuditEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  shipped = 0;
  failures = 0;
  readonly writer: string;

  constructor(
    private readonly warehouse: Warehouse,
    private readonly dataset: string,
    private readonly opts: { table?: string; flushMs?: number; maxBuffer?: number; writer?: string } = {},
  ) {
    this.writer = opts.writer ?? `${process.env.K_REVISION ?? "local"}-${randomId("w")}`;
  }

  write(e: AuditEntry): void {
    if (this.buffer.length >= (this.opts.maxBuffer ?? 10_000)) this.buffer.shift(); // drop the oldest rather than grow without bound
    this.buffer.push(e);
    this.timer ??= setTimeout(() => void this.flush(), this.opts.flushMs ?? 2_000);
  }

  get pending(): number {
    return this.buffer.length;
  }

  async flush(): Promise<void> {
    this.timer = null;
    const batch = this.buffer.splice(0, 500);
    if (!batch.length) return;
    try {
      await this.warehouse.insert(
        this.dataset,
        this.opts.table ?? "events",
        batch.map((e) => ({
          insertId: e.hash,
          json: { writer: this.writer, seq: e.seq, at: e.at, actor: e.actor, action: e.action, subject: e.subject, outcome: e.outcome, detail: JSON.stringify(e.detail), prev: e.prev, hash: e.hash },
        })),
      );
      this.shipped += batch.length;
    } catch {
      this.failures++;
      this.buffer.unshift(...batch); // try again with the next flush
    }
    if (this.buffer.length) this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 2_000);
  }
}
