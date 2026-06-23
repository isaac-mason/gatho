# gatho website

The landing page for gatho — and a live demo of itself. The page *is* a room:
everyone who loads it auto-joins one shared, permanent gatho room and sees every
other visitor's cursor in real time.

In production the static frontend is hosted on Cloudflare Pages and the backend
(gatho rooms + join API) runs on a single Hetzner box — see [`infra/`](./infra).

## Run locally

From the repo root (build the gatho package once if you haven't):

```sh
pnpm run build
./website/start.sh
```

- join api → http://localhost:7100
- frontend → http://localhost:7173

Open the frontend in two browser windows and move your mouse — each window sees
the other's cursor.

## How it works

- **`backend/src/server.ts`** — a gatho control plane (`gatho/server`) on an
  in-memory driver, plus a tiny Bun HTTP API. On startup it creates one
  permanent `landing` room. `POST /api/join` reserves a seat in it.
- **`backend/src/room.ts`** — the room runtime (`gatho/room`). Assigns each
  visitor a color + name, tracks last-known cursor positions, and broadcasts
  movement. New joiners get a snapshot of who's already present.
- **`frontend/`** — React + Vite. On load it calls `/api/join`, connects with
  `gatho/client`, streams pointer moves (throttled to animation frames,
  unreliable), and renders everyone else's cursor.

In dev, the frontend uses a relative `/api` (vite proxies it to the backend); in
prod it's built with `VITE_API_URL` pointed at `rooms.gatho.dev`.

## Roadmap

1. ✅ Flat multiplayer cursors.
2. ✅ Deploy: Cloudflare Pages (frontend) + Hetzner box (backend), via OpenTofu.
3. three.js visual layer — leading idea "The Onebox": a glowing server with a
   beam from each connected cursor.
4. Live HUD — deployed git SHA, occupancy, uptime, latency.
5. Pin a stable room port so cursors survive a redeploy via gatho's reconnection
   buffering.
