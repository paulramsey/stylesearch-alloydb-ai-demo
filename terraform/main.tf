terraform {
  required_providers {
    google = {
      source  = "hashicorp/google-beta"
      version = ">= 5.35.0" 
    }
    local = {
      source  = "hashicorp/local"
      version = ">= 2.1"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.1"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.5.1"
    }
  }
}

# Configure the Google Cloud provider
provider "google" {
  project = var.gcp_project_id
  region  = var.region
}

# Get authentication token for the local-exec provisioner
data "google_client_config" "current" {}

# Enable the required Google Cloud APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "aiplatform.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "alloydb.googleapis.com",
    "logging.googleapis.com",
    "storage-component.googleapis.com",
    "serviceusage.googleapis.com",
    "networkmanagement.googleapis.com",
    "servicenetworking.googleapis.com",
    "dns.googleapis.com",
    "vpcaccess.googleapis.com",
    "iam.googleapis.com",
    "compute.googleapis.com",
    "networkconnectivity.googleapis.com",
    "notebooks.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudtrace.googleapis.com",
    "monitoring.googleapis.com",
    "iap.googleapis.com"
  ])
  service                    = each.key
  disable_dependent_services = true
}

# Access the project data object
data "google_project" "project" {
  project_id = var.gcp_project_id
}

# Get execution environment IP for network security rules
data "http" "myip" {
  url = "https://ipv4.icanhazip.com"
}

# Override the Argolis policies
resource "null_resource" "override_argolis_policies" {
  depends_on = [google_project_service.apis]

  provisioner "local-exec" {
    command = <<-EOT
      # Update org policies
      echo "Updating org policies"
      declare -a policies=("constraints/run.allowedIngress"
        "constraints/iam.allowedPolicyMemberDomains"
        "constraints/compute.vmExternalIpAccess"
      )
      for policy in "$${policies[@]}"; do
        cat <<EOF >new_policy.yaml
      constraint: $policy
      listPolicy:
        allValues: ALLOW
      EOF
        gcloud resource-manager org-policies set-policy new_policy.yaml --project="${var.gcp_project_id}"
      done

      # Wait for policies to apply
      echo "Waiting 90 seconds for Org policies to apply..."
      sleep 90
    EOT
  }
}

# Create a custom VPC
resource "google_compute_network" "demo_vpc" {
  name                    = "demo-vpc"
  auto_create_subnetworks = true
  mtu                     = 1460
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.apis]
}

# Create a Cloud Router
resource "google_compute_router" "router" {
  name    = "nat-router"
  network = google_compute_network.demo_vpc.id
  region  = var.region
}

# Create a Cloud NAT Gateway
resource "google_compute_router_nat" "nat" {
  name                               = "managed-nat-gateway"
  router                             = google_compute_router.router.name
  region                             = google_compute_router.router.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Create firewall rule for IAP internal traffic
resource "google_compute_firewall" "iap_internal_communication" {
  name    = "allow-iap-internal"
  network = google_compute_network.demo_vpc.name
  project = var.gcp_project_id

  allow {
    protocol = "all"
  }

  source_ranges = ["35.235.240.0/20"]
  direction   = "INGRESS"
  priority    = 1000 # You can adjust the priority if needed. Lower numbers have higher precedence.
  description = "Allows internal TCP communication for IAP."
}

# Reserve a private IP range for service networking
resource "google_compute_global_address" "private_ip_alloc" {
  name          = "private-ip-alloc"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.demo_vpc.id
}

# Create a private VPC connection
resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.demo_vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_alloc.name]
}

# Create an AlloyDB cluster with PSA
resource "google_alloydb_cluster" "default" {
  cluster_id      = var.alloydb_cluster_id
  location        = var.region
  deletion_policy = "force"
  project         = var.gcp_project_id
  initial_user {
    password = var.alloydb_password
  }
  network_config {
    network = google_compute_network.demo_vpc.id
    allocated_ip_range = google_compute_global_address.private_ip_alloc.name
  }
  depends_on = [
    google_project_service.apis,
    google_service_networking_connection.private_vpc_connection
  ]
}

# Create a single-zone AlloyDB instance with PSA
resource "google_alloydb_instance" "primary" {
  depends_on = [ 
    null_resource.override_argolis_policies, 
    google_project_iam_member.project_alloydb_sa_roles 
  ]
  
  cluster         = google_alloydb_cluster.default.name
  instance_id     = var.alloydb_instance_id
  instance_type   = "PRIMARY"
  availability_type = "ZONAL"
  machine_config {
    cpu_count = 2
  }
  database_flags = {
    "google_columnar_engine.enabled"                = "on"
    "google_columnar_engine.enable_vectorized_join" = "on"
    "google_ml_integration.enable_model_support"    = "on"
    "password.enforce_complexity"                   = "on"
    "password.min_uppercase_letters"                = "1"
    "password.min_numerical_chars"                  = "1"
    "password.min_pass_length"                      = "10"
  }
  client_connection_config {
    ssl_config {
      ssl_mode = "ALLOW_UNENCRYPTED_AND_ENCRYPTED"
    }
  }
  #  Public IP configuration
  network_config {
    enable_public_ip = true
    authorized_external_networks {
        cidr_range = "${chomp(data.http.myip.response_body)}/32"
    }
  }
}



# --- START: Section for assigning permissions to the AlloyDB service account ---

# Define lists of roles to assign to the default compute service account
locals {
  # Roles to be applied to the GCP project
  alloydb_sa_project_roles = [
    "roles/aiplatform.user",
    "roles/alloydb.serviceAgent", # Required for AlloyDB to create tenant projects and manage resources
    "roles/serviceusage.serviceUsageConsumer",
    "roles/storage.admin",
    "roles/servicenetworking.serviceAgent"
    # Add any other project-wide roles here
  ]
}

# Define the service account name once to keep the code DRY (Don't Repeat Yourself)
locals {
  alloydb_service_account_member = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-alloydb.iam.gserviceaccount.com"
}

# Loop: Create IAM role bindings for the GCP PROJECT
resource "google_project_iam_member" "project_alloydb_sa_roles" {
  depends_on = [ google_alloydb_cluster.default ]
  
  # This for_each creates a resource instance for each role in the list
  for_each = toset(local.alloydb_sa_project_roles)

  project = data.google_project.project.id
  role    = each.key # 'each.key' refers to the current role in the loop
  member  = local.alloydb_service_account_member
}

# --- END: Section for assigning permissions to the AlloyDB service account ---

# --- START: Section for creating the database and importing data ---

# This resource creates the 'ecom' database in the AlloyDB cluster.
# It uses a local-exec provisioner to run a psql command.
resource "null_resource" "create_database" {
  depends_on = [google_alloydb_instance.primary]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Creating the ecom database"
      sql=$(
        cat <<EOF
      CREATE DATABASE ${var.alloydb_database};
      EOF
      )
      echo $sql | PGPASSWORD=${var.alloydb_password} psql -h "${google_alloydb_instance.primary.public_ip_address}" -U postgres -d postgres
    EOT
  }
}

# This resource installs the required extensions in the 'ecom' database.
# It runs after the database is created.
resource "null_resource" "install_extensions" {
  depends_on = [null_resource.create_database]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Creating the ecom database"
      sql=$(
        cat <<EOF
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE EXTENSION IF NOT EXISTS google_ml_integration;
      CREATE EXTENSION IF NOT EXISTS alloydb_scann;
      EOF
      )
      echo $sql | PGPASSWORD=${var.alloydb_password} psql -h "${google_alloydb_instance.primary.public_ip_address}" -U postgres -d ${var.alloydb_database}
    EOT
  }
}

# This resource creates the 'agentspace_user' role required by the import script.
resource "random_password" "agentspace_user_password" {
  length           = 16
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "null_resource" "create_agentspace_user" {
  depends_on = [null_resource.install_extensions]

  provisioner "local-exec" {
    command = <<-EOT
      gcloud alloydb users create agentspace_user \
        --cluster=${google_alloydb_cluster.default.name} \
        --region=${var.region} \
        --project=${var.gcp_project_id} \
        --password='${random_password.agentspace_user_password.result}'
    EOT
  }
}

# This resource triggers the data import from the GCS bucket.
# It uses a local-exec provisioner to make a REST API call, similar to the notebook.
resource "null_resource" "import_data" {
  depends_on = [
    null_resource.create_agentspace_user,
    google_project_iam_member.project_alloydb_sa_roles
  ]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Starting AlloyDB data import..."
      OPERATION_NAME=$(curl -X POST \
        -H "Authorization: Bearer $(gcloud auth print-access-token)" \
        -H "Content-Type: application/json; charset=utf-8" \
        -d '{
              "gcsUri": "${var.database_backup_uri}",
              "database": "${var.alloydb_database}",
              "user": "postgres",
              "sqlImportOptions": {}
            }' \
        "https://alloydb.googleapis.com/v1/projects/${var.gcp_project_id}/locations/${var.region}/clusters/${google_alloydb_cluster.default.name}:import" | jq -r .name)

      if [ -z "$OPERATION_NAME" ]; then
        echo "Failed to start import operation."
        exit 1
      fi

      echo "Import operation started: $OPERATION_NAME. Waiting for completion..."

      # Poll for completion
      gcloud alloydb operations wait $OPERATION_NAME \
        --project=${var.gcp_project_id} \
        --region=${var.region}

      echo "AlloyDB data import completed."
    EOT
  }
}

# --- END: Section for creating the database and importing data ---
