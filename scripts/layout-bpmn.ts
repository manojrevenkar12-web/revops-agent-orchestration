/**
 * Adds diagram information (shapes and edges) to the BPMN files so Camunda Modeler, Operate and the console can
 * draw them. The process semantics are written by hand; the layout is generated and committed.
 *   npx tsx scripts/layout-bpmn.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layoutProcess } from "bpmn-auto-layout";

const dir = join(import.meta.dirname, "..", "processes");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".bpmn"))) {
  const xml = readFileSync(join(dir, f), "utf8");
  const withoutDi = xml.replace(/\s*<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, "");
  const laid = await layoutProcess(withoutDi);
  writeFileSync(join(dir, f), laid.endsWith("\n") ? laid : `${laid}\n`);
  console.log(`laid out ${f}`);
}
