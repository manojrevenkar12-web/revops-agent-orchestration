terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.12"
    }
  }
  # State in a GCS bucket created once per project: terraform init -backend-config="bucket=<project>-tfstate"
  backend "gcs" {
    prefix = "revops-agent-orchestration"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
