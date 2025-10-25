output "vpc_name" {
  description = "The name of the created VPC."
  value       = google_compute_network.demo_vpc.name
}

output "alloydb_cluster_name" {
  description = "The name of the AlloyDB cluster."
  value       = google_alloydb_cluster.default.name
}

output "alloydb_private_ip" {
  description = "The private IP address of the AlloyDB instance."
  value       = google_alloydb_instance.primary.ip_address
}

output "alloydb_public_ip" {
  description = "The public IP address of the AlloyDB instance."
  value       = google_alloydb_instance.primary.public_ip_address
}

output "demo_app_url" {
  description = "The URL of the deployed Cymbal Shops demo application."
  value       = google_cloud_run_v2_service.demo_app.uri
}