#!/usr/bin/env bash
# runs on the box (shipped + invoked by deploy.sh). installs caddy if missing,
# then (re)starts the backend service and reloads the proxy. idempotent.
set -euo pipefail

# --- swap in freshly-uploaded binaries ---
# rename works even while the old binary is still running; a direct overwrite
# would fail with ETXTBSY ("text file busy").
if [ -f /opt/gatho/server.new ]; then mv -f /opt/gatho/server.new /opt/gatho/server; fi
if [ -f /opt/gatho/room.new ]; then mv -f /opt/gatho/room.new /opt/gatho/room; fi
chmod +x /opt/gatho/server /opt/gatho/room

# --- caddy (host service, for TLS + reverse proxy) ---
if ! command -v caddy >/dev/null 2>&1; then
	apt-get update -qq
	apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
	apt-get update -qq
	apt-get install -y -qq caddy
fi

# --- backend service (the compiled bun binary, which spawns room binaries) ---
install -m 644 /opt/gatho/gatho.service /etc/systemd/system/gatho.service
systemctl daemon-reload
systemctl enable gatho >/dev/null 2>&1 || true
systemctl restart gatho

# --- caddy config ---
install -m 644 /opt/gatho/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "provisioned: gatho + caddy running."
