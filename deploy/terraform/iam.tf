# One service account per service, each with only what it needs.
resource "google_service_account" "sa" {
  for_each     = toset(["orchestrator", "mcp", "agent", "scheduler", "deployer"])
  account_id   = "revops-${each.key}"
  display_name = "RevOps ${each.key}"
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = { for pair in flatten([for secret, users in local.secrets : [for u in users : { key = "${secret}/${u}", secret = secret, user = u }]]) : pair.key => pair }
  secret_id = google_secret_manager_secret.s[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa[each.value.user].email}"
}

# The orchestrator and the MCP server write audit rows; the MCP server reads product usage and support tickets.
resource "google_bigquery_dataset_iam_member" "audit_writers" {
  for_each   = toset(["orchestrator", "mcp"])
  dataset_id = google_bigquery_dataset.audit.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.sa[each.key].email}"
}

resource "google_bigquery_dataset_iam_member" "product_readers" {
  for_each   = toset(var.product_datasets)
  dataset_id = each.value
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.sa["mcp"].email}"
}

resource "google_project_iam_member" "bq_jobs" {
  for_each = toset(["orchestrator", "mcp"])
  project  = var.project_id
  role     = "roles/bigquery.jobUser"
  member   = "serviceAccount:${google_service_account.sa[each.key].email}"
}

# Claude on Vertex AI for the agent service (the second provider in config/agent.yaml).
resource "google_project_iam_member" "agent_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.sa["agent"].email}"
}

# Who may call whom. The MCP server and the agent service are never public.
resource "google_cloud_run_v2_service_iam_member" "orchestrator_calls_mcp" {
  name     = google_cloud_run_v2_service.mcp.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.sa["orchestrator"].email}"
}

resource "google_cloud_run_v2_service_iam_member" "analysts_call_mcp" {
  for_each = toset(var.console_viewers)
  name     = google_cloud_run_v2_service.mcp.name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}

resource "google_cloud_run_v2_service_iam_member" "orchestrator_calls_agent" {
  name     = google_cloud_run_v2_service.agent.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.sa["orchestrator"].email}"
}

# HubSpot and Slack must reach the webhooks; every request is checked against its signature in the application.
resource "google_cloud_run_v2_service_iam_member" "webhooks_public" {
  name     = google_cloud_run_v2_service.orchestrator.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
