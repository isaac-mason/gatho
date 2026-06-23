#!/usr/bin/env bash
# one-stop deploy. with no argument it converges everything: infra (tofu), the
# backend on the box, then the frontend on cloudflare pages. pass a phase to run
# just one:
#
#   ./deploy.sh            # infra + backend + frontend
#   ./deploy.sh infra      # tofu apply only
#   ./deploy.sh backend    # rsync repo + provision the box
#   ./deploy.sh frontend   # build + push to pages
#
# append --yes to auto-approve the tofu apply (for CI / unattended runs).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env"

PHASE="all"
TF_APPROVE=""
for arg in "$@"; do
  case "$arg" in
    infra | backend | frontend | all) PHASE="$arg" ;;
    --yes | -y) TF_APPROVE="-auto-approve" ;;
    *)
      echo "unknown arg: $arg (expected: infra|backend|frontend|all, --yes)" >&2
      exit 1
      ;;
  esac
done

# load infra/.env if present; otherwise rely on tokens already in the environment.
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
# CLOUDFLARE_API_TOKEN is needed by every phase (tofu provider + wrangler); the
# others are checked in the phase that needs them.
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set (infra/.env or the environment)}"

tf() { tofu -chdir="$HERE" "$@"; }

run_infra() {
  echo "[deploy] infra — box + firewall + dns + pages project"
  : "${HCLOUD_TOKEN:?HCLOUD_TOKEN must be set (infra/.env or the environment)}"
  tf init
  tf apply $TF_APPROVE
}

run_backend() {
  echo "[deploy] backend — compile binaries + ship"
  : "${ACME_EMAIL:?ACME_EMAIL must be set (infra/.env or the environment)}"
  local ip host key bindir
  ip="$(tf output -raw server_ipv4)"
  host="$(tf output -raw hostname)"
  key="$HERE/.ssh/id_ed25519"
  bindir="$REPO_ROOT/website/backend/dist-bin"
  # don't touch the user's known_hosts — tofu-managed boxes recycle IPs, which
  # would otherwise trip "host key changed". the box is created by us via tofu.
  local ssh_opts=(-i "$key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

  # compile the server + room to standalone linux binaries (baseline x64 = safe
  # on any cpx/cx box). builds gatho dist first so `gatho/*` imports resolve.
  echo "  compile (bun --> linux x64)"
  ( cd "$REPO_ROOT" && pnpm run build >/dev/null )
  mkdir -p "$bindir"
  bun build "$REPO_ROOT/website/backend/src/server.ts" --compile --target=bun-linux-x64-baseline --outfile "$bindir/server" >/dev/null
  bun build "$REPO_ROOT/website/backend/src/room.ts" --compile --target=bun-linux-x64-baseline --outfile "$bindir/room" >/dev/null

  # a freshly-created box needs a moment to boot + start sshd
  echo "  waiting for ssh on $ip..."
  for _ in $(seq 1 40); do
    if ssh "${ssh_opts[@]}" -o ConnectTimeout=5 -o BatchMode=yes "root@$ip" true 2>/dev/null; then
      break
    fi
    sleep 5
  done

  echo "  ship binaries + config -> $ip"
  ssh "${ssh_opts[@]}" "root@$ip" "mkdir -p /opt/gatho"

  # render the Caddyfile with the real host + email, then ship it
  sed -e "s/__SITE_HOST__/$host/g" -e "s/__ACME_EMAIL__/$ACME_EMAIL/g" "$HERE/files/Caddyfile" \
    | ssh "${ssh_opts[@]}" "root@$ip" "cat > /opt/gatho/Caddyfile"

  ssh "${ssh_opts[@]}" "root@$ip" "cat > /opt/gatho/gatho.env" <<EOF
PUBLIC_URL=https://$host
ROOM_BIN=/opt/gatho/room
EOF

  # binaries upload to .new — you can't overwrite a running executable in place
  # (ETXTBSY). provision.sh renames them in (atomic, works while the old runs).
  scp "${ssh_opts[@]}" "$bindir/server" "root@$ip:/opt/gatho/server.new"
  scp "${ssh_opts[@]}" "$bindir/room" "root@$ip:/opt/gatho/room.new"
  scp "${ssh_opts[@]}" "$HERE/files/gatho.service" "$HERE/files/provision.sh" "root@$ip:/opt/gatho/"

  ssh "${ssh_opts[@]}" "root@$ip" "chmod +x /opt/gatho/provision.sh && bash /opt/gatho/provision.sh"
  echo "  backend live at https://$host"
}

run_frontend() {
  echo "[deploy] frontend"
  local api_url project
  api_url="$(tf output -raw api_url)"
  project="$(tf output -raw pages_project)"
  # wrangler needs the account id (discovered by tofu) + the api token (from .env).
  export CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_ACCOUNT_ID="$(tf output -raw cloudflare_account_id)"

  echo "  build (VITE_API_URL=$api_url)"
  ( cd "$REPO_ROOT" && pnpm install --no-frozen-lockfile >/dev/null && pnpm run build )
  ( cd "$REPO_ROOT" && VITE_API_URL="$api_url" pnpm --filter gatho-website-frontend run build )

  echo "  push to pages project '$project'"
  ( cd "$REPO_ROOT/website/frontend" && npx --yes wrangler pages deploy dist --project-name "$project" --branch main )
  echo "  frontend live at $(tf output -raw frontend_url)"
}

case "$PHASE" in
  infra) run_infra ;;
  backend) run_backend ;;
  frontend) run_frontend ;;
  all)
    run_infra
    run_backend
    run_frontend
    ;;
esac

echo "[deploy] done."
