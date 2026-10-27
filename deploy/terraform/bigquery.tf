resource "google_bigquery_dataset" "audit" {
  dataset_id  = "revops_audit"
  location    = var.bigquery_location
  description = "Append-only audit of every tool call, approval, model call and decision by the RevOps automations."
  depends_on  = [google_project_service.apis]
}

resource "google_bigquery_table" "events" {
  dataset_id          = google_bigquery_dataset.audit.dataset_id
  table_id            = "events"
  deletion_protection = true
  time_partitioning {
    type  = "DAY"
    field = "at"
  }
  clustering = ["action", "subject"]
  schema = jsonencode([
    { name = "writer", type = "STRING", mode = "REQUIRED", description = "the instance whose hash chain this entry belongs to" },
    { name = "seq", type = "INT64", mode = "REQUIRED" },
    { name = "at", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "actor", type = "STRING", mode = "REQUIRED" },
    { name = "action", type = "STRING", mode = "REQUIRED" },
    { name = "subject", type = "STRING", mode = "REQUIRED" },
    { name = "outcome", type = "STRING", mode = "REQUIRED" },
    { name = "detail", type = "JSON", mode = "NULLABLE", description = "ids, hashes and statuses; never message text or personal data" },
    { name = "prev", type = "STRING", mode = "REQUIRED" },
    { name = "hash", type = "STRING", mode = "REQUIRED" },
  ])
}
