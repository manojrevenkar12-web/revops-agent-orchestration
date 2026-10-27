# Design

## The problem

A revenue team runs on many systems (Salesforce, Gainsight, Salesloft, Clari, Impartner, HubSpot, Slack, the product
warehouse). Work between them is repetitive and slow: triaging inbound requests, spotting renewals at risk,
deciding partner registrations. Models can read and draft much of it, but a revenue team has to be able to trust
what reaches its systems: who decided, on what evidence, within which limits, and what happens when the model or a
system fails.

## The split of responsibilities

| Concern | Where it lives | Why |
| --- | --- | --- |
| Flow, waiting, deadlines, escalation, retries, incidents | BPMN in Camunda | Visible to the business, versioned, operable in Operate |
| Rules (routing, registration policy) | DMN tables | Owned by Marketing Ops and Partnerships, explainable per rule |
| Thresholds and modes | `config/automations.yaml`, passed as the `policy` variable | Reviewed like code; each instance records the policy it ran under |
| Reading and drafting | The agent service (Claude) | Structured output, calibrated, checked |
| Access to GTM systems | The MCP server | One place for credentials, scopes, approvals, idempotency, audit |
| Decisions a person must make | Slack Block Kit, correlated back as a Camunda message | People decide where they already work |

## Key mechanisms

**Approval tokens.** `approval.issue` signs `{tool, sha256(canonical(args)), instance, approvedBy, exp, jti}` with
HMAC. The MCP server verifies tool, argument hash and expiry before any write, and records the first result per
`jti`, so a retried job never writes twice and a model cannot reuse an approval for different arguments. For a
person's approval the token is issued only if the planned changes still hash to what the Slack message showed.

**The agent loop.** The renewal investigation is a BPMN ad-hoc sub-process with a job worker implementation (the
pattern of Camunda's AI Agent). Each job asks the agent service for the next step; tool calls become activations of
inner service tasks (`mcp.call`), each with retries and its own audit entry; results return through the
`outputCollection`. The agent answers only when every parallel tool call has returned. A time budget (timer
boundary) and a model-call limit (BPMN error `NO_BRIEF`) bound the loop.

**Grounding and risk.** The agent's view of risk is not the decision: a logistic model over the same facts, fitted
on history from other seeds through the same MCP tool code, gives the probability the policy compares with 0.80.
The brief is checked claim by claim (cited ids exist in the evidence, numbers match the cited fact or its
definition). An ungrounded brief never becomes a proposal; the CSM gets the facts instead.

**Calibration.** The lead classifier's raw score is discounted by vocabulary coverage, then mapped through isotonic
regression with Laplace smoothing; below the calibration data the result is never above the raw score. Calibration
is per model and prompt version: a live model without a fitted file returns confidence 0.

**Stateless orchestrator.** Camunda holds approval requests and decisions as process variables; HubSpot, Slack and
the scheduler become messages with message ids; audit goes to BigQuery. One always-on Cloud Run instance runs the
workers; the API scales with it.

**Salesforce limits.** The connector reads `Sforce-Limit-Info` on every response and keeps a reserve of the daily
allowance (background work stops at 20 % remaining, interactive at 5 %), retries only transient errors
(`UNABLE_TO_LOCK_ROW`, 503), reads in bulk through Bulk API 2.0, writes by external id. A rate limit backs off but
does not open the circuit breaker.

## The local engine

Tests and the evaluation need Camunda semantics without a cluster (Docker images and Maven are not reachable from
the build environment). `packages/engine` executes the subset the processes use: service, script, business rule,
user and receive tasks; exclusive and parallel gateways; message and timer events (duration, date, cycle);
interrupting and non-interrupting boundary events; error events; embedded and ad-hoc sub-processes with job-worker
results; incidents and their resolution; message buffering with TTL and message ids; message start events with one
instance per correlation key. It refuses everything else at deploy time. Conformance is checked from two sides:
Camunda's own 8.8 TypeScript client with strict response validation runs against its REST API, and Camunda's 8.8
compatibility lint (the rules Desktop Modeler applies) runs over the BPMN. It is a test double, not a replacement
for Zeebe.

## What is not built

- The Salesforce Pub/Sub API (gRPC) transport for CDC; the subscriber, replay store and gap recovery are built and
  tested against the sandbox's HTTP transport.
- A calibration for a live Claude model (needs labelled submissions and an API key).
- Console authentication (planned behind IAP; the console API is read-only).
