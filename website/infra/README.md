# website/infra

OpenTofu deployment for the gatho website. Split across two hosts:

- **Frontend** — static SPA on **Cloudflare Pages** (free), at `gatho.dev`.
- **Backend** — the Bun server (gatho rooms + join API) on **one Hetzner box**, at
  `rooms.gatho.dev`. It's a stateful in-memory websocket server, so it needs a
  persistent box (cheapest sensible: a CAX11, ~€4/mo).

```
                      ┌─ gatho.dev ────────── Cloudflare Pages (static frontend)
visitor ──────────────┤                              │ fetch /api/join + wss
                      └─ rooms.gatho.dev ─── Hetzner box: Caddy :443 ──┬─ /room/<port> ─▶ localhost:<port>
                                                                       └─ /api/*       ─▶ localhost:7100
```

The frontend is built with `VITE_API_URL=https://rooms.gatho.dev`, so it calls the
backend cross-origin (the API sends permissive CORS; websockets aren't CORS-gated).
The backend emits room urls as `wss://rooms.gatho.dev/room/<port>` via `PUBLIC_URL`.

## What it provisions

- One `hcloud_server` (Debian 12) + firewall (:22/:80/:443).
- A generated ed25519 SSH deploy key (`.ssh/`, gitignored).
- Cloudflare: an A record for `rooms.gatho.dev` → the box, a Pages project, its
  custom domain (`gatho.dev`), and the CNAME pointing at it.

On the box there's **no Docker** — the backend is two standalone binaries built
with `bun build --compile` (one `server`, one `room`; the server spawns rooms as
`room` subprocesses on localhost ports). `deploy.sh` cross-compiles them locally
and ships them; they run as a **systemd** service (`gatho`) behind host **Caddy**
(TLS + reverse proxy). No build, pnpm, or registry on the box.

## One-time setup

1. Install [OpenTofu](https://opentofu.org/docs/intro/install/) and have `pnpm` +
   `npx` available (the frontend deploy uses `wrangler` via `npx`).
2. `cp .env.example .env` and fill it in — `HCLOUD_TOKEN`, `CLOUDFLARE_API_TOKEN`
   (needs **Zone:DNS:Edit** + **Account:Cloudflare Pages:Edit**, which also grant
   the zone/account reads below), `ACME_EMAIL`.

That's it. The Cloudflare **zone id and account id are discovered by tofu** from
the domain name (`cloudflare_zone_name`, default `gatho.dev`) — no need to paste
ids. Hostnames/sizing also default (rooms.gatho.dev / gatho.dev / CAX11); override
any with a `TF_VAR_*` env var or a `terraform.tfvars`.

To just read the discovered ids:

```sh
set -a; . .env; set +a && tofu init >/dev/null
echo 'data.cloudflare_zones.this.result[0].id'    | tofu console
echo 'data.cloudflare_accounts.this.result[0].id' | tofu console
# or, after an apply: tofu output cloudflare_zone_id / cloudflare_account_id
```

## Deploy

One script. With no argument it converges everything (infra → backend → frontend);
pass a phase to run just one:

```sh
./deploy.sh            # infra + backend + frontend
./deploy.sh infra      # tofu apply only
./deploy.sh backend    # compile binaries + ship them to the box
./deploy.sh frontend   # build + push to pages
```

Append `--yes` to auto-approve the tofu apply (CI / unattended).

## Redeploy

- Backend change → `./deploy.sh backend`
- Frontend change → `./deploy.sh frontend`

## Teardown

```sh
tofu destroy
```

## Notes / trade-offs

- **Local tofu state** — fine for this; `terraform.tfstate` is gitignored.
- **Compiled binaries, not Docker.** `bun build --compile` produces two static
  linux binaries (~90 MB each, Bun runtime embedded), cross-compiled on your Mac
  and scp'd to the box. No build/pnpm/registry on the box, no 2 GB-RAM build worry.
- **Pages = direct upload.** We build locally (where the pnpm monorepo build works)
  and `wrangler pages deploy` the dist, instead of Cloudflare's build system. tofu
  owns the project + domain + dns.
- **Room ws routing** is keyed on the dynamic port (`/room/<5-digit-port>`). A
  redeploy restarts the backend, so the port changes and in-flight clients re-join
  on next load. Pinning a stable port (to carry cursors through a redeploy via
  gatho's reconnection buffering) is a future step.
