variable "hostname" {
  description = "Hostname for the backend (Hetzner box) — serves /api + room websockets."
  type        = string
  default     = "rooms.gatho.dev"
}

variable "frontend_hostname" {
  description = "Hostname for the static frontend, served by Cloudflare Pages."
  type        = string
  default     = "gatho.dev"
}

variable "cloudflare_zone_name" {
  description = "The Cloudflare zone (apex domain) owning the hostnames — its id + the account id are looked up from this."
  type        = string
  default     = "gatho.dev"
}

variable "pages_project_name" {
  description = "Cloudflare Pages project name (also its <name>.pages.dev subdomain)."
  type        = string
  default     = "gatho-website"
}

variable "server_name" {
  description = "Name/label for the Hetzner server."
  type        = string
  default     = "gatho-website"
}

variable "server_type" {
  description = "Hetzner server type. cpx11 = 2 vCPU / 2 GB (AMD x86, ~€3.85/mo, US-capable). cax11 = ARM (EU-only)."
  type        = string
  default     = "cpx11"
}

variable "location" {
  description = "Hetzner location (ash/hil US x86, fsn1/nbg1/hel1 EU). Try another if you hit 'resource_unavailable'."
  type        = string
  default     = "ash"
}

variable "server_image" {
  description = "Base OS image."
  type        = string
  default     = "debian-12"
}
