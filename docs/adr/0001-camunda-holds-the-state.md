# 0001 Camunda holds the state; the orchestrator holds none

Status: accepted

The orchestrator first kept approval requests in a local file and deduplicated registration polls in memory. On
Cloud Run both are lost on restart. Approval requests and decisions are now process variables of the instance that
asked; Slack clicks are correlated (`correlateMessage`), so a click on a closed request fails visibly instead of
being buffered; registration polls use a message id with a seven-day TTL. Consequence: no database to run, and the
console reads approvals through Camunda's search API. Cost: the console's approvals list is a join of three searches,
which is fine at RevOps volumes (thousands of instances) and would need an exporter-fed store at much larger scale.
