# --- cloudflare lookups ---
# discover the zone id + account id from the domain name, so neither has to be
# pasted in by hand. the account comes off the zone itself (no separate accounts
# list, which a zone/pages-scoped token can't read).

data "cloudflare_zones" "this" {
  name = var.cloudflare_zone_name
}

locals {
  cloudflare_zone_id    = data.cloudflare_zones.this.result[0].id
  cloudflare_account_id = data.cloudflare_zones.this.result[0].account.id
}

# --- ssh key ---
# generated here and written to infra/.ssh/ (gitignored). deploy.sh uses it to
# rsync the repo and run the provision script. self-contained — no dependency on
# the operator's personal ssh keys.

resource "tls_private_key" "ssh" {
  algorithm = "ED25519"
}

resource "local_sensitive_file" "ssh_private_key" {
  filename        = "${path.module}/.ssh/id_ed25519"
  content         = tls_private_key.ssh.private_key_openssh
  file_permission = "0600"
}

resource "hcloud_ssh_key" "this" {
  name       = "${var.server_name}-key"
  public_key = tls_private_key.ssh.public_key_openssh
}

# --- firewall ---
# only ssh + http(s). the api (:3100) and the rooms' ephemeral ports listen on
# the host (network_mode: host) but are never exposed publicly — all traffic
# reaches them through Caddy on :443.

resource "hcloud_firewall" "this" {
  name = "${var.server_name}-fw"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# --- server ---
# cloud-init installs docker; everything else is owned by provision.sh so edits
# ship without recreating the box.

resource "hcloud_server" "web" {
  name         = var.server_name
  server_type  = var.server_type
  image        = var.server_image
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.this.id]
  firewall_ids = [hcloud_firewall.this.id]
  user_data    = file("${path.module}/files/cloud-init.yaml")

  labels = {
    project = "gatho"
    role    = "website"
  }
}

# --- backend dns ---
# unproxied A record for the box: Caddy terminates TLS on it (HTTP-01 needs the
# real IP reachable on :80), and the frontend hits it directly over wss/https.

resource "cloudflare_dns_record" "backend" {
  zone_id = local.cloudflare_zone_id
  name    = var.hostname
  type    = "A"
  content = hcloud_server.web.ipv4_address
  ttl     = 60
  proxied = false
}

# --- frontend (cloudflare pages) ---
# direct-upload project: we build locally (where the pnpm monorepo build already
# works) and push the dist with wrangler — see deploy.sh (frontend phase). tofu owns the
# project, its custom domain, and the dns record that points at it.

resource "cloudflare_pages_project" "frontend" {
  account_id        = local.cloudflare_account_id
  name              = var.pages_project_name
  production_branch = "main"
}

resource "cloudflare_pages_domain" "frontend" {
  account_id   = local.cloudflare_account_id
  project_name = cloudflare_pages_project.frontend.name
  name         = var.frontend_hostname
}

# proxied CNAME (apex flattening) from the frontend hostname to the pages project.
resource "cloudflare_dns_record" "frontend" {
  zone_id = local.cloudflare_zone_id
  name    = var.frontend_hostname
  type    = "CNAME"
  content = "${cloudflare_pages_project.frontend.name}.pages.dev"
  ttl     = 1
  proxied = true
}
