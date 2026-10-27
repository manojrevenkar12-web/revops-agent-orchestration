import { AuditLog } from "@revops/core";
import { buildConnectors } from "@revops/connectors";
import { startSandbox } from "@revops/sandbox";
import { expect, it } from "vitest";
import { BigQueryAuditSink } from "@revops/connectors";

it("ships audit entries to BigQuery in batches, keyed by their hash so a retried batch is stored once", async () => {
  const sb = await startSandbox();
  try {
    const c = buildConnectors({ baseUrl: sb.url, sleep: async () => undefined });
    const sink = new BigQueryAuditSink(c.warehouse, "revops_audit", { flushMs: 60_000, writer: "test-writer" });
    const audit = new AuditLog();
    audit.addSink(sink);
    for (let i = 0; i < 3; i++) audit.append({ actor: "test", action: "tool.call", subject: `tool/t${i}`, outcome: "ok", detail: { i } });
    await sink.flush();
    const rows = sb.gtm.bqInserts["revops_audit.events"] ?? [];
    expect(rows.map((r) => r.subject)).toEqual(["tool/t0", "tool/t1", "tool/t2"]);
    expect(rows[1]?.prev).toBe(rows[0]?.hash);
    expect(rows.every((r) => r.writer === "test-writer")).toBe(true);
    // the same entries again (a retry after a timeout) are not stored twice
    await c.warehouse.insert(
      "revops_audit",
      "events",
      audit.list(() => true, 10).map((e) => ({ insertId: e.hash, json: { hash: e.hash } })),
    );
    expect(sb.gtm.bqInserts["revops_audit.events"]).toHaveLength(3);
    expect(sink.shipped).toBe(3);
  } finally {
    await sb.close();
  }
});
