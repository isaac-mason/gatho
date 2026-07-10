# gatho × workerd — rooms as v8 isolates

Runs gatho multiplayer rooms as **v8 isolates inside ONE long-lived `workerd`
process**, using workerd's `workerLoader` binding (Cloudflare "Dynamic Workers").
Spawning a room is an HTTP admission call + isolate load (~ms, a few MB), not a
process launch — so one process hosts many rooms.

This is **example code**: everything here builds only on gatho's public API
(`gatho/server`, `gatho/room`, `gatho/sdk`, `gatho/driver`, `gatho/client`). The
heavy deps (`workerd` binary, `esbuild`) live in this example's own
`package.json`, not in gatho core.

## Run it

```sh
pnpm install
pnpm run demo
```

`demo.ts` starts a node gatho server (memory driver) with the `workerd()` runner,
creates an **echo** room and a **cursor** room concurrently (two isolates in one
workerd process), connects real WebSocket clients, and asserts:

- **echo-to-sender** and **broadcast-to-all** round-trips in the echo room, and
- an independent second isolate (the cursor room),

then prints `DEMO PASSED`. `pnpm run typecheck` typechecks the example.

## Run the SPA (the website demo, on isolates)

A full replica of `website/` — the landing page where every visitor is a live
cursor — except the cursor room runs as a **v8 isolate inside workerd** instead
of a subprocess:

```sh
./start.sh
# backend (join api)  → http://localhost:7300
# frontend            → http://localhost:7373
```

Open http://localhost:7373 in two browser windows and move your mouse — each
window sees the other's cursor, and the footer shows which room (isolate) you're
in. Pieces:

- **`server.ts`** — onebox backend: gatho control plane with
  `landing: workerd({ entry: './rooms/landing.ts' })`, plus the website's
  matchmaking join API (`POST /api/join` → fullest room with space, up to 32 per
  room; a full house spins up a new *isolate*, not a new process) and empty-room
  cleanup.
- **`rooms/landing.ts`** — the website's cursor room, ported to the `(room) =>
  options` factory export. One workerd adaptation: the website's ~15Hz `setInterval` batch tick
  becomes an **armed-on-demand `setTimeout` flush** (first dirty move schedules a
  66ms flush) — workerd timers only fire while the isolate is active, and while
  cursors stream at ~20Hz it is; when everyone's idle there's nothing to flush.
- **`shared/protocol.ts`** — the website's packcat binary wire format (6
  bytes/cursor/tick). It builds codecs with `new Function` at module init, which
  only loads in the isolate thanks to the `allow_eval_during_startup` flag — a
  nice proof that real binary-protocol rooms work under that flag.
- **`frontend/`** — React + Vite SPA (adapted from `website/frontend`): joins via
  `/api/join` (vite proxies to :7300), connects with `gatho/client`, streams
  pointer moves unreliably at ~20Hz, renders everyone else's cursors.

Headless check of the same data path (no browser): `pnpm run start` in one
terminal, `pnpm run test:spa` in another — two protocol-speaking clients join,
move, and assert snapshot/join/frame/presence flow.

## Architecture

```
node process (the gatho server)                    one workerd process
───────────────────────────────────               ──────────────────────────────
start({ rooms: { echo: workerd({entry}) }})        harness worker (static, generated once)
  │                                                  ├─ CLIENT socket  :Pc  default export
  │  driver assigns a room                           │    routes /:roomId/* ws upgrades
  ▼                                                  │    into the room isolate
workerd() runner  (host/host.ts)                     ├─ ADMIN socket   :Pa  Admin entrypoint
  ├─ ensureHost(): spawn `workerd serve` once,       │    POST /rooms/:id  → LOADER.get(id, …)
  │   refcounted; bundle harness with esbuild        │    DELETE /rooms/:id, POST /__gatho/tick
  ├─ per room: esbuild the room module + adapter     └─ NotifierRelay entrypoint
  │   (content-cached), POST admission                    per-room loopback service binding
  ├─ jsonNotifyListener → ctx.notifier                          ▲
  └─ tick loop: POST /__gatho/tick every 1.5s                   │ env.NOTIFIER.notify(json)
        │                                                        │
        │  newline-JSON over loopback TCP        ┌───────────────┴───────────────┐
        └──────────◄─────────────────────────────┤ room isolate (v8, workerLoader)│
                                                  │  adapter/index.ts:            │
   real ws client ──────ws://:Pc/roomId?token──► │   WebSocketPair transport      │
                                                  │   create(roomModule(room),{…}) │
                                                  └────────────────────────────────┘
```

- **`rooms/*.ts`** — a room module. State lives at module scope; callbacks close
  over it. It default-exports a **`RoomModule` factory** (`(room) => options`,
  typed `RoomModule<ClientData>`). The two-phase room api drops the `room` param
  from callbacks, so the factory threads the room handle in — capacity checks and
  broadcasts use the closed-over handle. This factory shape is **this example's own
  convention, not a gatho API** — a workerd module can't call top-level `create()`
  because env/bindings only arrive per-request, so the module exports the factory
  and the adapter calls `create(factory(room))` + `room.start()` on the first
  request. Each loaded isolate evaluates the module fresh, so module-scope state is
  per-room, exactly like a subprocess.
- **`adapter/index.ts`** — `createWorkerdRoom(factory)` → an `ExportedHandler`.
  Implements the gatho `Transport` contract over `WebSocketPair`, and a `Notifier`
  over the injected `NOTIFIER` binding.
- **`harness/harness.ts`** — the static entry worker: client routing, admission
  API, and the notify relay.
- **`host/host.ts`** — the `workerd({ entry })` runner factory + singleton host
  manager (spawn/refcount/bundle/tick).

## Findings (for the runner-notify-channel plan)

Tested against the `workerd` npm binary **1.20260704.1** (darwin-arm64), node 24.

### workerLoader works — and single-process affinity is real

- `workerLoader` is in OSS workerd. Config: `(name = "LOADER", workerLoader = ())`
  on the harness worker, run with **`--experimental`** and compat flags
  **`["nodejs_compat", "enable_ctx_exports", "experimental"]`**. `enable_ctx_exports`
  is required for `ctx.exports.NotifierRelay(...)` (the per-room loopback binding).
- **WS upgrade through `stub.getEntrypoint().fetch(req)` works** — the client half
  of a `WebSocketPair` returned as `new Response(null, { status: 101, webSocket })`
  flows back through the harness to the real client.
- **Isolate affinity holds in a single self-hosted process.** `env.LOADER.get(id)`
  gives one-isolate-per-name: module-scope state persists across requests, and two
  *concurrent* WebSocket connections to the same `roomId` land in the **same**
  isolate (verified: both clients saw `conns=2` and the same module-scope id). So
  module-scope room state is safe here — no Durable Object pinning needed *for state*.
  (The docs' "not guaranteed same isolate" warning did not bite in single-process
  workerd; a multi-process pool would need real pinning.)
- **`limits: { cpuMs, subRequests }`** is a field on the loader's `WorkerCode`, so
  CPU limits are expressible via the loader (not exercised here). Memory limits are
  not enforced in OSS workerd — shard across host processes if you need containment.

### The dominant constraint: I/O is request-context-bound

workerd forbids using an I/O object (TCP stream, WebSocket) from a different
request context than the one that created it. This shaped the whole design:

- **`WorkerStub` is itself context-bound** — you can't cache the stub from
  admission and reuse it later (you get `WorkerStubChannel` cross-context errors).
  Fix: store the room *config* and call `env.LOADER.get(id, factory)` in **every**
  request; the loader cache returns a context-local stub to the same isolate.
- **The notify TCP socket** is owned by the admission request (kept alive for the
  room's lifetime with `ctx.waitUntil`). Notify RPCs from other contexts only push
  JSON onto an in-memory queue that the admission-context relay loop drains.
- **WebSocket broadcast is the hard one.** A gatho room broadcast sends to *every*
  client's socket — but those sockets were accepted in *other* requests, so direct
  `ws.send` fails cross-context. **Durable Objects (the canonical Cloudflare fix)
  are NOT available to dynamically-loaded workers** — `WorkerCode` has no
  `durableObjectNamespaces` field. Worked around with a **per-connection outbox +
  drain loop**: each connection's loop runs in the one context where its socket is
  valid (kept alive via `waitUntil` until close), and the engine only ever pushes
  bytes onto outboxes + signals loops. This makes send/echo/broadcast all work in a
  single isolate — at the cost of holding a request context open per live
  connection. For production scale, the contract-correct answer is a Durable Object
  per room with the WebSocket Hibernation API, which the loader can't currently give
  us.

### packcat codegen is blocked in isolates — the key acceptance-test finding

gatho frames its wire protocol with **packcat**, which builds serializers using
`new Function(...)`. **workerd forbids runtime code generation** ("Code generation
from strings disallowed"). Two impacts:

- The room engine's **client protocol codec** (`common/protocol.ts`) builds at
  module init. Fixed by adding the **`allow_eval_during_startup`** compat flag to
  the room's `WorkerCode` — it permits `new Function` during startup only (the built
  codecs run fine at request time). Without it the isolate can't even load the engine.
- The **notify codec** (`encodeNotifyFrame`/`notifyCodec`, exported from
  `gatho/room` *specifically so a non-node runtime can relay*) has the same problem.
  Rather than eval, the harness relays **newline-delimited JSON** to a host-side
  listener that feeds `ctx.notifier` directly. So the plan's proposed
  `tcpNotifier(uri)` export is **not usable inside a workerd isolate as-is** — this
  is the load-bearing finding for "the workerd example builds on public API only":
  it does, but only because we route around packcat, and the room engine still needs
  a non-default workerd flag to run.

### gatho/room pulls node-only modules into the bundle

(RESOLVED upstream.) `dist/room.js` used to statically import `ws` and `http`,
defeating tree-shaking even with a custom transport — this example originally
worked around it with esbuild alias shims. gatho now loads all node-only deps
(`ws`, `http`, `node:net`) lazily inside code paths an isolate never runs, so
the bundle carries only inert dynamic imports: we mark them `external` and the
shims are gone. No export-condition split turned out to be needed.

### Idle isolates and timers

workerd timers don't fire while an isolate is idle, so `start()`'s own `setInterval`
heartbeat can't be relied on. The host pings `/__gatho/tick` every 1.5s; the adapter
**synthesizes the heartbeat** from that tick using the clients whose sockets are open
(the same ground truth the server's reconciler expects). `ready` flows on the room's
first request (warmed at admission). Verified: a client-less room **survives 13s
idle** (past the 10s stall-sweep timeout). The 1.5s tick vs 3s engine interval vs
10s stall margin all hold.

## What would make this a first-class integration

Two core changes (both in the plan) would remove the workarounds:

1. A **workerd export condition** for `gatho/room` that (a) omits `ws`/`http`/
   `node:net` and (b) provides a **codegen-free notify codec** (or documents the
   `allow_eval_during_startup` requirement), so `encodeNotifyFrame` is usable in an
   isolate and the harness can relay real notify frames via `notify.tcp`.
2. Guidance (or a helper) for the **broadcast-across-contexts** problem, since
   Durable Objects aren't reachable through `workerLoader` — the per-connection
   drain-loop pattern here is the portable answer for plain loaded workers.
