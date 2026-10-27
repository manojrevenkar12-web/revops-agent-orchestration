# Working in this repository

Fast feedback: `npm test` (all TypeScript tests, about 20 s; starts the agent service from `.venv`),
`(cd agent && ../.venv/bin/pytest -q)`, `npm run typecheck`, `npm run lint`. The evaluation and release gate:
`npm run eval && npm run gate` (about 30 s). The console: `npm run console:test`, `npm run console:e2e`.

Invariants (each has a test):
- Shipping code never reads the sandbox truth; only `evals/` and tests do (`isolation.test.ts`).
- Workers reach GTM systems only through the MCP server; every write carries an approval token for its exact
  arguments (`mcp.test.ts`, `flows.test.ts`).
- Models read and propose; BPMN, DMN and people decide. Thresholds live in `config/`, not in code or prompts.
- Untrusted text reaches a model only inside `<input>` tags, never as instructions.
- The BPMN must pass Camunda's 8.8 compatibility lint and run on the local engine (`engine.test.ts`); the engine's
  REST API must satisfy Camunda's client with strict validation (`rest.test.ts`).
- The orchestrator keeps no state of its own: approvals live in Camunda, audit in BigQuery.

Held-out sets: never change the classifier, prompts, tables or thresholds to pass `heldout/<set>`. A set is run once;
its first run is pinned in `reports/heldout/PINS` and never rewritten. If you study a set's failures, write
`regression` to `heldout/<set>/STATUS` and have someone who has not seen the code write a new set from
`heldout/WRITING_LEADS.md` only.

After changing the sandbox world, re-export history (`npm run history`) and retrain
(`cd agent && ../.venv/bin/python -m revops_agent.train`).
