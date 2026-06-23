output "server_ipv4" {
  description = "Public IPv4 of the Hetzner box."
  value       = hcloud_server.web.ipv4_address
}

output "hostname" {
  description = "Backend (box) hostname."
  value       = var.hostname
}

output "api_url" {
  description = "Public origin of the backend — the frontend points VITE_API_URL here."
  value       = "https://${var.hostname}"
}

output "frontend_url" {
  description = "Public URL of the Cloudflare Pages frontend."
  value       = "https://${var.frontend_hostname}"
}

output "pages_project" {
  description = "Cloudflare Pages project name (for wrangler deploys)."
  value       = var.pages_project_name
}

output "cloudflare_zone_id" {
  description = "Zone id looked up from the zone name."
  value       = local.cloudflare_zone_id
}

output "cloudflare_account_id" {
  description = "Account id looked up from the token."
  value       = local.cloudflare_account_id
}

output "ssh_key_path" {
  description = "Path to the generated private key used for deploys."
  value       = local_sensitive_file.ssh_private_key.filename
}
