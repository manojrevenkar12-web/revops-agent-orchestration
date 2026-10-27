locals {
  services = ["run.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "bigquery.googleapis.com", "cloudscheduler.googleapis.com", "iamcredentials.googleapis.com", "aiplatform.googleapis.com", "sts.googleapis.com"]
  image    = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"

  # Secrets: Terraform creates the containers; values are added out of band (gcloud secrets versions add ...),
  # so no secret value ever sits in Terraform state.
  secrets = {
    "camunda-client-secret"    = ["orchestrator"]
    "mcp-orchestrator-token"   = ["orchestrator"]
    "mcp-approval-secret"      = ["orchestrator", "mcp"]
    "mcp-orchestrator-hash"    = ["mcp"]
    "mcp-analyst-hash"         = ["mcp"]
    "agent-service-token"      = ["orchestrator", "agent"]
    "hubspot-client-secret"    = ["orchestrator"]
    "slack-bot-token"          = ["orchestrator"]
    "slack-signing-secret"     = ["orchestrator"]
    "salesforce-client-secret" = ["orchestrator", "mcp"]
    "gainsight-access-key"     = ["mcp"]
    "salesloft-api-key"        = ["mcp"]
    "clari-api-key"            = ["mcp"]
    "impartner-key"            = ["mcp"]
    "anthropic-api-key"        = ["agent"]
  }
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  repository_id = "revops"
  format        = "DOCKER"
  location      = var.region
  description   = "Images for the RevOps automation layer"
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.secrets
  secret_id = each.key
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}
