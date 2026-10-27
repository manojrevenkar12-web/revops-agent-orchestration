import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Clock, repoRoot, systemClock } from "@revops/core";
import Fastify, { type FastifyInstance } from "fastify";
import { Engine } from "./engine";
import { registerEngineRest } from "./rest";

/** The BPMN and DMN files the RevOps automations deploy (processes/). */
export function processResources(dir = join(repoRoot(), "processes")): Array<{ name: string; content: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".bpmn") || f.endsWith(".dmn"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
}

/** An engine with its REST API, the processes deployed. A real-time engine ticks every second. */
export async function buildEngineServer(opts: { clock?: Clock; deploy?: boolean; tickMs?: number } = {}): Promise<{ app: FastifyInstance; engine: Engine; stop: () => void }> {
  const engine = new Engine(opts.clock ?? systemClock);
  if (opts.deploy !== false) await engine.deploy(processResources());
  const app = Fastify({ logger: false, bodyLimit: 5_000_000, forceCloseConnections: true });
  registerEngineRest(app, engine);
  const timer = opts.tickMs ? setInterval(() => engine.tick(), opts.tickMs) : undefined;
  timer?.unref();
  return { app, engine, stop: () => timer && clearInterval(timer) };
}
