/**
 * The whole platform on one machine: the GTM sandbox, the local engine with the processes deployed, the MCP
 * server, the agent service (Python, simulated provider unless AGENT_PROVIDER=live), the orchestrator's API and
 * its workers. Everything shares the sandbox clock, so a 24-hour approval deadline can be crossed in a test.
 *
 * Used by `npm run dev`, the integration tests and the evaluation harness.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AuditLog, repoRoot } from "@revops/core";
import { buildConnectors } from "@revops/connectors";
import { buildEngineServer } from "@revops/engine";
import { buildMcpHttpService } from "@revops/mcp-server";
import { DEFAULT_KEYS, startSandbox } from "@revops/sandbox";
import { buildApi } from "./api";
import { AgentClient, camunda, McpGateway } from "./clients";
import { FileApprovalStore } from "./slack";
import { startWorkers } from "./workers";

export interface StackOptions {
  seed?: number;
  agentFaults?: Record<string, number>;
  ports?: { sandbox?: number; engine?: number; mcp?: number; agent?: number; api?: number };
  quiet?: boolean;
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

const listen = async (app: { listen: (o: { port: number; host: string }) => Promise<unknown>; server: { address(): unknown } }, port = 0) => {
  await app.listen({ port, host: "127.0.0.1" });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
};

async function startAgent(port: number, faults: Record<string, number> | undefined, quiet: boolean): Promise<{ url: string; proc: ChildProcess }> {
  const root = repoRoot();
  const python = existsSync(join(root, ".venv/bin/python")) ? join(root, ".venv/bin/python") : "python3";
  const proc = spawn(python, ["-m", "uvicorn", "revops_agent.app:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
    cwd: join(root, "agent"),
    env: { ...process.env, AGENT_PROVIDER: process.env.AGENT_PROVIDER ?? "simulated", AGENT_FAULTS: faults ? JSON.stringify(faults) : "", REVOPS_ROOT: root },
    stdio: quiet ? "ignore" : "inherit",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return { url, proc };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("the agent service did not start (is the Python environment installed? see README)");
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export async function startStack(opts: StackOptions = {}) {
  const sb = await startSandbox({ seed: opts.seed ?? 7 });
  const clock = sb.clock;
  const audit = new AuditLog();
  const engineSrv = await buildEngineServer({ clock });
  const engineUrl = await listen(engineSrv.app, opts.ports?.engine);
  // Waiting (retry back-off, Retry-After) moves the shared clock instead of real time.
  const connectors = buildConnectors({ baseUrl: sb.url, sleep: async (ms) => clock.advance(ms), now: () => clock.now().getTime() });
  const mcpSvc = buildMcpHttpService({ connectors, audit, clock });
  await new Promise<void>((r) => mcpSvc.http.listen(opts.ports?.mcp ?? 0, "127.0.0.1", r));
  const mcpUrl = `http://127.0.0.1:${(mcpSvc.http.address() as AddressInfo).port}/mcp`;
  const agent = await startAgent(opts.ports?.agent ?? (await freePort()), opts.agentFaults, opts.quiet ?? true);

  const client = camunda(`${engineUrl}/v2`);
  const mcp = new McpGateway(mcpUrl, "orchestrator-dev-token");
  const approvals = new FileApprovalStore();
  const seen = new Set<string>();
  let apiUrl = "";
  const api = buildApi({
    camunda: client,
    mcp,
    slack: connectors.slack,
    approvals,
    audit,
    clock,
    hubspotSecret: DEFAULT_KEYS.hubspotClientSecret,
    slackSigningSecret: DEFAULT_KEYS.slackSigningSecret,
    schedulerToken: "dev-scheduler-token",
    publicBaseUrl: () => apiUrl,
    seen,
    consoleDir: join(repoRoot(), "apps", "console", "dist"),
  });
  apiUrl = await listen(api, opts.ports?.api);
  const workers = startWorkers(client, {
    mcp,
    agent: new AgentClient(agent.url, "dev-agent-token"),
    slack: connectors.slack,
    channels: connectors.cfg.slack.channels,
    teams: (connectors.cfg.slack as unknown as { teams: Record<string, string> }).teams ?? {},
    approvals,
    audit,
    approvalSecret: mcpSvc.cfg.approvals.secret,
    clock,
  });

  /** Move every clock forward and let timers fire. */
  const advance = async (ms: number) => {
    clock.advance(ms);
    engineSrv.engine.tick();
  };
  /**
   * Wait until no job is waiting for a worker (the platform is idle, or waiting for people or timers). Jobs that
   * failed and wait for their back-off would wait forever on a stopped clock, so the clock moves to the earliest
   * retry, as it would in real time.
   */
  const settle = async (timeoutMs = 60_000) => {
    const until = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < until) {
      const jobs = [...engineSrv.engine.jobs.values()];
      const running = jobs.some((j) => j.state === "ACTIVATED" || (j.state === "ACTIVATABLE" && (j.retryAtMs ?? 0) <= clock.now().getTime()));
      const backingOff = jobs.filter((j) => j.state === "ACTIVATABLE" && (j.retryAtMs ?? 0) > clock.now().getTime());
      if (!running && backingOff.length) {
        const next = Math.min(...backingOff.map((j) => j.retryAtMs as number));
        await advance(next - clock.now().getTime());
        quiet = 0;
        continue;
      }
      quiet = running ? 0 : quiet + 1;
      if (quiet >= 3) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("the platform did not settle");
  };
  const stop = async () => {
    await workers.stop();
    await mcp.close();
    await api.close();
    mcpSvc.http.close();
    engineSrv.stop();
    await engineSrv.app.close();
    agent.proc.kill();
    await sb.close();
  };
  return { sb, clock, audit, engine: engineSrv.engine, engineUrl, mcpUrl, apiUrl, agentUrl: agent.url, approvals, client, mcp, advance, settle, stop };
}
