# Runbook

## Pause an automation

Set `mode: review_all` for it in `config/automations.yaml` and deploy. New instances ask a person for every case
(renewals: every brief is proposed to the CSM). Running instances keep the policy they started with (it is a process
variable). To stop starting instances at all, pause the Cloud Scheduler job or disable the HubSpot webhook.

## An incident in Operate

| Element | Usual cause | Action |
| --- | --- | --- |
| `UpsertLead`, `CreateCta`, `DecideInImpartner` (`mcp.call`) | `approval_required`, `arguments differ` | A bug, not an outage: the plan changed after approval. Do not retry; open the case in the console, compare the audit trail, fix the cause, cancel the instance. |
| any `mcp.call` | `API_BUDGET_RESERVED` | The Salesforce reserve is reached; jobs retry every 15 minutes. Check `/limits` and who is using the allowance. |
| `IssueApprovals` | `changes differ from what the person approved` | The plan was recomputed between the Slack message and the click. Cancel; the next form submission will ask again. |
| `ClassifyLead`, agent tasks | agent service unreachable | Check the agent service; the lead path falls back to a person on `MODEL_UNAVAILABLE` by itself. |

Resolve with retries: `updateJob(retries)` then `resolveIncident`, or in Operate.

## The model is unavailable or over budget

Lead classification fails over to Vertex AI, then to a person (`MODEL_UNAVAILABLE`). The renewal agent hands the
facts to the CSM (`NO_BRIEF`). When the daily token budget is used, jobs back off for 15 minutes. Check
`/healthz` of the agent service for breaker states.

## Change a model or a prompt

1. Run the labelled calibration set through the new model and fit `agent/models/calibration/<model>--<prompt>.json`.
2. `npm run eval && npm run gate`.
3. Run the next unused held-out set once and pin its first run. Never tune on a held-out set; if you study its
   failures, mark it `regression` and have someone write a new one from the guide.

## Rotate a secret

Add a new version in Secret Manager (`gcloud secrets versions add`), then redeploy the service that reads it (Cloud
Run reads `latest` at start). For the MCP client tokens, store the new SHA-256 in `mcp-orchestrator-hash` /
`mcp-analyst-hash` and the token itself in `mcp-orchestrator-token`. Rotating `mcp-approval-secret` invalidates
approvals issued but not yet used: do it when no approval is waiting.

## Audit

Every tool call, approval and model call is an entry in `revops_audit.events`, hash-chained per writer. To check a
chain: select a writer's entries ordered by `seq` and recompute `sha256(prev + canonical(entry))`.
