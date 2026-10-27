variable "project_id" {
  description = "GCP project that runs the RevOps automation layer."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Artifact Registry and Scheduler. Data stays in the EU."
  type        = string
  default     = "europe-west3"
}

variable "bigquery_location" {
  type    = string
  default = "EU"
}

variable "image_tag" {
  description = "Image tag deployed by CI (the commit SHA)."
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through Workload Identity Federation."
  type        = string
  default     = "manojrevenkar12-web/revops-agent-orchestration"
}

variable "camunda_rest_address" {
  description = "Camunda 8.8 Orchestration Cluster REST address, e.g. https://<region>.zeebe.camunda.io/<cluster-id>/v2"
  type        = string
}

variable "camunda_oauth_url" {
  type    = string
  default = "https://login.cloud.camunda.io/oauth/token"
}

variable "camunda_client_id" {
  type = string
}

variable "public_base_url" {
  description = "The orchestrator's public URL (HubSpot and Slack call it; the HubSpot signature covers it)."
  type        = string
}

variable "product_datasets" {
  description = "Existing BigQuery datasets the MCP server reads (product usage, support tickets)."
  type        = list(string)
  default     = ["product", "support"]
}

variable "console_viewers" {
  description = "Groups allowed to open the console and the analyst MCP endpoint (IAP / Cloud Run invoker)."
  type        = list(string)
  default     = []
}

variable "gtm_endpoints" {
  description = "Base URLs of the GTM systems and the Salesforce connected app's client id (not secret)."
  type = object({
    salesforce_login_url = string
    salesforce_client_id = string
    gainsight_url        = string
    salesloft_url        = string
    clari_url            = string
    impartner_url        = string
  })
}
