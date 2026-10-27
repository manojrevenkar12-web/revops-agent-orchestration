# Cloud Scheduler calls the orchestrator with a Google-signed OIDC token for its own service account.
resource "google_cloud_scheduler_job" "renewal_scan" {
  name      = "revops-renewal-scan"
  schedule  = "0 6 * * 1"
  time_zone = "Europe/Berlin"
  http_target {
    http_method = "POST"
    uri         = "${var.public_base_url}/jobs/renewal-scan"
    oidc_token {
      service_account_email = google_service_account.sa["scheduler"].email
      audience              = var.public_base_url
    }
  }
  retry_config {
    retry_count = 3
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "registration_poll" {
  name      = "revops-registration-poll"
  schedule  = "*/10 * * * *"
  time_zone = "Europe/Berlin"
  http_target {
    http_method = "POST"
    uri         = "${var.public_base_url}/jobs/registration-poll"
    oidc_token {
      service_account_email = google_service_account.sa["scheduler"].email
      audience              = var.public_base_url
    }
  }
  depends_on = [google_project_service.apis]
}
