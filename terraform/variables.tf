variable "gcp_project_id" {
  description = "The GCP project ID."
  type        = string
}

variable "region" {
  description = "The GCP region for resources."
  type        = string
  default     = "us-central1"
}

variable "alloydb_password" {
  description = "The password for the 'postgres' user in AlloyDB."
  type        = string
  sensitive   = true
}

variable "alloydb_cluster_id" {
  description = "The ID of the AlloyDB cluster."
  type        = string
  default     = "stylesearch-cluster"
}

variable "alloydb_instance_id" {
  description = "The ID of the AlloyDB primary instance."
  type        = string
  default     = "stylesearch-instance"
}

variable "alloydb_database" {
  description = "The name of the database to create in AlloyDB."
  type        = string
  default     = "ecom"
}

variable "database_backup_uri" {
  description = "The GCS URI of the SQL backup file for import."
  type        = string
  default     = "gs://pr-public-demo-data/alloydb-retail-demo/alloydb-export/ecom_generic.sql"
}

variable "demo_app_name" {
  description = "The name for the Cloud Run demo application service."
  type        = string
  default     = "cymbalshops"
}

variable "demo_app_repo_name" {
  description = "The name for the Artifact Registry repository."
  type        = string
  default     = "cymbalshops"
}

variable "demo_app_image_name" {
  description = "The name for the demo application Docker image."
  type        = string
  default     = "cymbalshops"
}