terraform {
  required_version = ">= 1.6.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      # pinned to match makecat.io/infra — the cloudflare_zones `name` filter
      # regressed in 5.20+ (returns an empty result), breaking the zone lookup.
      version = "5.19.1"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # local state — fine for a single-box demo. the state file + generated ssh key
  # are gitignored. (bongle uses a shared s3 backend; not worth it for one box.)
}

# tokens come from the environment (HCLOUD_TOKEN, CLOUDFLARE_API_TOKEN), sourced
# from infra/.env by deploy.sh — never hard-coded here.
provider "hcloud" {}
provider "cloudflare" {}
