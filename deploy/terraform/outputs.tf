output "orchestrator_url" {
  value = google_cloud_run_v2_service.orchestrator.uri
}

output "mcp_url" {
  value = "${google_cloud_run_v2_service.mcp.uri}/mcp"
}

output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  value = google_service_account.sa["deployer"].email
}
