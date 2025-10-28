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

# Set gcloud project scope
resource "null_resource" "gcloud_setup" {

  provisioner "local-exec" {
    command = <<-EOT
      gcloud config set project ${var.gcp_project_id}
      gcloud auth application-default set-quota-project ${var.gcp_project_id}
      gcloud auth configure-docker ${var.region}-docker.pkg.dev --quiet
    EOT
  }
}

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
  count = var.argolis ? 1 : 0
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

      rm new_policy.yaml

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
    "google_ml_integration.enable_ai_query_engine"  = "on"
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

  lifecycle {
    ignore_changes = [
      network_config
    ]
   }

}

# --- START: Section for creating the AlloyDB password secret ---

# Create a secret for the AlloyDB password
resource "google_secret_manager_secret" "alloydb_password" {
  depends_on = [google_project_service.apis]
  secret_id = "alloydb-password"
  project   = var.gcp_project_id

  replication {
    auto {}
  }
}

# Store the AlloyDB password in Secret Manager
resource "google_secret_manager_secret_version" "alloydb_password_version" {
  secret      = google_secret_manager_secret.alloydb_password.id
  secret_data = var.alloydb_password
}

# Grant the Compute SA access to the AlloyDB password secret
resource "google_secret_manager_secret_iam_member" "compute_sa_secret_accessor" {
  project   = var.gcp_project_id
  secret_id = google_secret_manager_secret.alloydb_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.compute_service_account
}

# --- END: Section for creating the AlloyDB password secret ---



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

# This resource upgrades the google_ml_integration extension in the 'ecom' database.
# This is required to enable preview features used in the demo, like the AI query engine.
resource "null_resource" "upgrade_extensions" {
  depends_on = [null_resource.install_extensions]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Creating the ecom database"
      sql=$(
        cat <<EOF
      CALL google_ml.upgrade_to_preview_version();
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
        --cluster=${var.alloydb_cluster_id} \
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
      gcloud alloydb clusters import ${var.alloydb_cluster_id} \
        --region=${var.region} \
        --project=${var.gcp_project_id} \
        --database=${var.alloydb_database} \
        --gcs-uri=${var.database_backup_uri} \
        --sql
    EOT
  }
}

resource "null_resource" "validate_row_counts" {
  depends_on = [null_resource.import_data]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Validating row counts for the ecom database"
      sql=$(
        cat <<EOF
      SELECT 'distribution_centers' AS table_name, (SELECT COUNT(*) FROM distribution_centers) AS actual_row_count, 10 AS target_row_count
      UNION ALL
      SELECT 'events', (SELECT COUNT(*) FROM events), 2438862
      UNION ALL
      SELECT 'inventory_items', (SELECT COUNT(*) FROM inventory_items), 494254
      UNION ALL
      SELECT 'orders', (SELECT COUNT(*) FROM orders), 125905
      UNION ALL
      SELECT 'order_items', (SELECT COUNT(*) FROM order_items), 182905
      UNION ALL
      SELECT 'products', (SELECT COUNT(*) FROM products), 29120
      UNION ALL
      SELECT 'users', (SELECT COUNT(*) FROM users), 100000;
      EOF
      )
      echo $sql | PGPASSWORD=${var.alloydb_password} psql -v ON_ERROR_STOP=on -h "${google_alloydb_instance.primary.public_ip_address}" -U postgres -d ${var.alloydb_database}
    EOT
  }
}

resource "null_resource" "create_standard_indexes" {
  depends_on = [null_resource.validate_row_counts]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Creating standard indexes for the ecom database"
      sql=$(
        cat <<EOF
      DROP INDEX IF EXISTS idx_products_brand;
      CREATE INDEX idx_products_brand ON products (brand);
      DROP INDEX IF EXISTS idx_products_category;
      CREATE INDEX idx_products_category ON products (category);
      DROP INDEX IF EXISTS idx_products_retail_price;
      CREATE INDEX idx_products_retail_price ON products (retail_price);
      DROP INDEX IF EXISTS idx_products_sku;
      CREATE INDEX idx_products_sku ON products (sku);
      EOF
      )
      echo $sql | PGPASSWORD=${var.alloydb_password} psql -v ON_ERROR_STOP=on -h "${google_alloydb_instance.primary.public_ip_address}" -U postgres -d ${var.alloydb_database}
    EOT
  }
}

resource "null_resource" "create_scann_vector_indexes" {
  depends_on = [null_resource.create_standard_indexes]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Creating ScaNN indexes for the ecom database"
      sql=$(
        cat <<EOF
      CREATE EXTENSION IF NOT EXISTS alloydb_scann;
      SET SESSION scann.num_leaves_to_search = 1;
      SET SESSION scann.pre_reordering_num_neighbors=50;
      DROP INDEX IF EXISTS embedding_scann;
      CREATE INDEX embedding_scann ON products
        USING scann (product_embedding cosine)
        WITH (num_leaves=2);
      DROP INDEX IF EXISTS product_description_embedding_scann;
      CREATE INDEX product_description_embedding_scann ON products
        USING scann (product_description_embedding cosine)
        WITH (num_leaves=2);
      DROP INDEX IF EXISTS product_image_embedding_scann;
      CREATE INDEX product_image_embedding_scann ON products
        USING scann (product_image_embedding cosine)
        WITH (num_leaves=2);
      EOF
      )
      echo $sql | PGPASSWORD=${var.alloydb_password} psql -v ON_ERROR_STOP=on -h "${google_alloydb_instance.primary.public_ip_address}" -U postgres -d ${var.alloydb_database}
    EOT
  }
}

resource "null_resource" "create_hnsw_vector_index" {
  depends_on = [null_resource.create_scann_vector_indexes]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Creating HNSW indexes for the ecom database"
      sql=$(
        cat <<EOF
      DROP INDEX IF EXISTS sparse_embedding_hnsw;
      CREATE INDEX sparse_embedding_hnsw ON products
        USING hnsw (sparse_embedding sparsevec_ip_ops)
        WITH (m = 16, ef_construction = 64);
      EOF
      )
      echo $sql | PGPASSWORD=${var.alloydb_password} psql -v ON_ERROR_STOP=on -h "${google_alloydb_instance.primary.public_ip_address}" -U postgres -d ${var.alloydb_database}
    EOT
  }
}

resource "null_resource" "create_gin_fts_index" {
  depends_on = [null_resource.create_hnsw_vector_index]

  provisioner "local-exec" {
    command = <<-EOT
      echo "Creating GIN index for the ecom database"
      sql=$(
        cat <<EOF
      DROP INDEX IF EXISTS products_fts_document_gin;
      CREATE INDEX products_fts_document_gin ON products USING GIN (fts_document);
      EOF
      )
      echo $sql | PGPASSWORD=${var.alloydb_password} psql -v ON_ERROR_STOP=on -h "${google_alloydb_instance.primary.public_ip_address}" -U postgres -d ${var.alloydb_database}
    EOT
  }
}

# --- END: Section for creating the database and importing data ---

# --- START: Section for assigning permissions to Cloud Build and Compute Service Accounts ---

# Define the service account names once to keep the code DRY
locals {
  compute_service_account = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
  cloudbuild_service_account = "serviceAccount:${data.google_project.project.number}@cloudbuild.gserviceaccount.com"
}

# Grant the default Compute SA the Storage Admin role so it can upload source to the Cloud Build bucket.
# Also grant it the Cloud Build Editor role to manage builds.
resource "google_project_iam_member" "compute_sa_build_roles" {
  depends_on = [google_project_service.apis]
  for_each = toset([
    "roles/storage.admin",
    "roles/cloudbuild.builds.editor",
    "roles/logging.logWriter",
    "roles/run.admin",
    "roles/artifactregistry.admin",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/serviceusage.serviceUsageViewer"
  ])

  project = data.google_project.project.id
  role    = each.key
  member  = local.compute_service_account
}

# Grant the Cloud Build SA the Artifact Registry Writer role so it can push container images.
resource "google_project_iam_member" "cloudbuild_sa_artifact_role" {
  depends_on = [google_project_service.apis]
  
  project = data.google_project.project.id
  role    = "roles/artifactregistry.writer"
  member  = local.cloudbuild_service_account
}


# --- END: Section for assigning permissions to Cloud Build and Compute Service Accounts ---


# --- START: Section for deploying the Demo App to Cloud Run ---

# Create an Artifact Registry repository to store the demo app container image
resource "google_artifact_registry_repository" "demo_app_repo" {
  depends_on = [
    google_project_service.apis,
    null_resource.validate_row_counts
  ]

  location      = var.region
  repository_id = var.demo_app_repo_name
  description   = "Docker repository for the Cymbal Shops demo application."
  format        = "DOCKER"
}

# Data source to get the auto-created subnetwork in the demo VPC for the specified region.
# This is needed to attach the Cloud Run service to the VPC.
data "google_compute_subnetwork" "auto_subnet" {
  depends_on = [google_compute_network.demo_vpc]
  name   = google_compute_network.demo_vpc.name
  region = var.region
}

# This null_resource builds the Docker image for the demo app using Cloud Build,
# tags it, and pushes it to the Artifact Registry.
resource "null_resource" "build_and_push_image" {
  depends_on = [
    google_artifact_registry_repository.demo_app_repo,
    null_resource.gcloud_setup
  ]

  # This provisioner will only run if the source code or Dockerfile changes.
  triggers = {
    api_source_hash      = filesha256("../demo_app/api/index.ts")
    ui_source_hash       = filesha256("../demo_app/ui/src/app/app.component.html")
    dockerfile_hash      = filesha256("../demo_app/Dockerfile")
    cloudbuild_yaml_hash = filesha256("../demo_app/cloudbuild.yaml")
    
    # Uncomment the line below to force the build to run every time
    #always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = <<-EOT
      echo "Submitting build to Google Cloud Build and waiting for completion..."
      gcloud builds submit ../demo_app \
        --config=../demo_app/cloudbuild.yaml \
        --project=${var.gcp_project_id} \
        --substitutions=_REGION=${var.region},_REPO_NAME=${google_artifact_registry_repository.demo_app_repo.repository_id},_IMAGE_NAME=${var.demo_app_image_name}
      
      echo "Cloud Build finished. Image should be available in Artifact Registry."
    EOT
  }
}


# Deploy the demo application to Cloud Run
resource "google_cloud_run_v2_service" "demo_app" {
  depends_on = [
    null_resource.build_and_push_image,
    google_secret_manager_secret_iam_member.compute_sa_secret_accessor
  ]

  name     = var.demo_app_name
  location = var.region
  project  = var.gcp_project_id

  deletion_protection = false

  template {
    containers {
      image = "${var.region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.demo_app_repo.repository_id}/${var.demo_app_image_name}:latest"
      ports {
        container_port = 8080
      }
      env {
        name  = "PGHOST"
        value = google_alloydb_instance.primary.ip_address
      }
      env {
        name  = "PGPORT"
        value = "5432"
      }
      env {
        name  = "PGDATABASE"
        value = var.alloydb_database
      }
      env {
        name  = "PGUSER"
        value = "postgres"
      }
      env {
        name = "PGPASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.alloydb_password.secret_id
            version = "latest"
          }
        }
      }
      env { 
        name = "PROJECT_ID"
        value = var.gcp_project_id 
      }
      env { 
        name = "REGION"
        value = var.region 
      }
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.demo_vpc.id
        subnetwork = data.google_compute_subnetwork.auto_subnet.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
  }
}

# Allow unauthenticated (public) access to the Cloud Run service
resource "google_cloud_run_v2_service_iam_member" "allow_public_access" {
  project  = google_cloud_run_v2_service.demo_app.project
  location = google_cloud_run_v2_service.demo_app.location
  name     = google_cloud_run_v2_service.demo_app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- END: Section for deploying the Demo App to Cloud Run ---

# This null resource disables public IP on the AlloyDB instance
# This is the final step in the setup and ensures a more secure config
resource "null_resource" "disable_public_ip_alloydb" {
  depends_on = [
    google_cloud_run_v2_service.demo_app
  ]

  provisioner "local-exec" {
    command = <<-EOT
      gcloud alloydb instances update  ${var.alloydb_instance_id} \
        --cluster=${var.alloydb_cluster_id} \
        --region=${var.region} \
        --project=${var.gcp_project_id} \
        --assign-inbound-public-ip=NO_PUBLIC_IP
      echo "Kicked off operation to disable public IP on the AlloyDB instance"
    EOT
  }
}