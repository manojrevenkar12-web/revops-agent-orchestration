locals {
  secret_env = {
    orchestrator = {
      CAMUNDA_CLIENT_SECRET    = "camunda-client-secret"
      MCP_TOKEN                = "mcp-orchestrator-token"
      MCP_APPROVAL_SECRET      = "mcp-approval-secret"
      AGENT_SERVICE_TOKEN      = "agent-service-token"
      HUBSPOT_CLIENT_SECRET    = "hubspot-client-secret"
      SLACK_BOT_TOKEN          = "slack-bot-token"
      SLACK_SIGNING_SECRET     = "slack-signing-secret"
      SALESFORCE_CLIENT_SECRET = "salesforce-client-secret"
    }
    mcp = {
      MCP_APPROVAL_SECRET           = "mcp-approval-secret"
      MCP_ORCHESTRATOR_TOKEN_SHA256 = "mcp-orchestrator-hash"
      MCP_ANALYST_TOKEN_SHA256      = "mcp-analyst-hash"
      SALESFORCE_CLIENT_SECRET      = "salesforce-client-secret"
      GAINSIGHT_ACCESS_KEY          = "gainsight-access-key"
      SALESLOFT_API_KEY             = "salesloft-api-key"
      CLARI_API_KEY                 = "clari-api-key"
      IMPARTNER_KEY                 = "impartner-key"
    }
    agent = {
      ANTHROPIC_API_KEY   = "anthropic-api-key"
      AGENT_SERVICE_TOKEN = "agent-service-token"
    }
  }
}

# The GTM MCP server: internal, IAM-authenticated, scales to zero.
resource "google_cloud_run_v2_service" "mcp" {
  name     = "revops-mcp"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    service_account = google_service_account.sa["mcp"].email
    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }
    containers {
      image = "${local.image}/mcp-server:${var.image_tag}"
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      dynamic "env" {
        for_each = {
          GCP_PROJECT          = var.project_id
          SALESFORCE_LOGIN_URL = var.gtm_endpoints.salesforce_login_url
          SALESFORCE_CLIENT_ID = var.gtm_endpoints.salesforce_client_id
          GAINSIGHT_URL        = var.gtm_endpoints.gainsight_url
          SALESLOFT_URL        = var.gtm_endpoints.salesloft_url
          CLARI_URL            = var.gtm_endpoints.clari_url
          IMPARTNER_URL        = var.gtm_endpoints.impartner_url
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env.mcp
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.access]
}

# The agent service: internal, IAM-authenticated; Claude through the Anthropic API, then Vertex AI.
resource "google_cloud_run_v2_service" "agent" {
  name     = "revops-agent"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    service_account = google_service_account.sa["agent"].email
    timeout         = "120s"
    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }
    containers {
      image = "${local.image}/agent:${var.image_tag}"
      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }
      env {
        name  = "VERTEX_PROJECT"
        value = var.project_id
      }
      dynamic "env" {
        for_each = local.secret_env.agent
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.access]
}

# The orchestrator: webhooks, Slack interactions, scheduled jobs, the console API and the job workers. It keeps no
# state (approvals live in Camunda, audit in BigQuery); one always-on instance runs the workers and the CDC stream.
resource "google_cloud_run_v2_service" "orchestrator" {
  name     = "revops-orchestrator"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.sa["orchestrator"].email
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network = "default"
      }
    }
    containers {
      image = "${local.image}/orchestrator:${var.image_tag}"
      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = false # workers poll Camunda between requests
      }
      dynamic "env" {
        for_each = {
          CAMUNDA_REST_ADDRESS      = var.camunda_rest_address
          CAMUNDA_AUTH_STRATEGY     = "OAUTH"
          CAMUNDA_CLIENT_ID         = var.camunda_client_id
          CAMUNDA_OAUTH_URL         = var.camunda_oauth_url
          MCP_URL                   = "${google_cloud_run_v2_service.mcp.uri}/mcp"
          MCP_AUDIENCE              = google_cloud_run_v2_service.mcp.uri
          AGENT_URL                 = google_cloud_run_v2_service.agent.uri
          AGENT_AUDIENCE            = google_cloud_run_v2_service.agent.uri
          PUBLIC_BASE_URL           = var.public_base_url
          SCHEDULER_SERVICE_ACCOUNT = google_service_account.sa["scheduler"].email
          GCP_PROJECT               = var.project_id
          # The Pub/Sub API (gRPC) transport for Change Data Capture is not built yet; the sandbox transport is HTTP.
          # Until it is, renewals are found by the weekly scan only.
          CDC_ENABLED          = "false"
          SALESFORCE_LOGIN_URL = var.gtm_endpoints.salesforce_login_url
          SALESFORCE_CLIENT_ID = var.gtm_endpoints.salesforce_client_id
          SLACK_API_URL        = "https://slack.com"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env.orchestrator
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.access]
}
