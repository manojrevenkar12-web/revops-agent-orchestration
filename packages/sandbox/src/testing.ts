import { type Sandbox, buildSandbox } from "./server";

/** Start a sandbox on a free port for a test file. */
export async function startSandbox(opts: { seed?: number } = {}): Promise<Sandbox & { url: string; close: () => Promise<void> }> {
  const sb = buildSandbox(opts);
  await sb.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = sb.app.server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return { ...sb, url, close: () => sb.app.close() };
}
