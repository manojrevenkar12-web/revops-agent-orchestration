import { buildSandbox } from "./server";

const port = Number(process.env.SANDBOX_PORT ?? 9300);
const sb = buildSandbox({ seed: Number(process.env.SANDBOX_SEED ?? 7) });
await sb.app.listen({ port, host: process.env.SANDBOX_HOST ?? "127.0.0.1" });
console.log(JSON.stringify({ msg: "gtm sandbox listening", port, accounts: sb.world.accounts.length, forms: sb.world.forms.length }));
