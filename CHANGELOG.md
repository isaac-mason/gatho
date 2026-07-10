# CHANGELOG

## v0.0.1 (Unreleased)

- Initial release!
- **driver:** the Postgres driver is removed (`createPostgresDriver` and
  `PostgresDriverOptions` are gone, and the `postgres` dependency is dropped). Its push-based
  room delivery relied on `LISTEN`/`NOTIFY`, whose payload limits and delivery semantics make
  it a poor fit for the driver model. Memory and Redis remain; other backends (e.g. an SNS +
  DynamoDB driver) may be revisited later.
- **server:** per-room UDS sockets now live at `socketDir/<roomId>/sock` instead of the
  flat `socketDir/<roomId>.sock`. This lets a container runner mount each room only its
  own socket directory, isolating the (unauthenticated) server↔room IPC channel from
  sibling containers — important when rooms run untrusted code. `SpawnContext` gains a
  `socketDir` field giving the room's own socket directory, so a runner just mounts
  `ctx.socketDir` into the room. Rooms are unaffected (they resolve the socket from env). The
  socket filename is `sock` (not `room.sock`) so the new path is the same length as the
  old flat one — unix socket paths have a hard ~104-byte limit (macOS) that the long
  default `tmpdir()` already pushes against. **Breaking** only for custom runners that
  hardcode the old flat `<roomId>.sock` path.
- **server:** the server core no longer owns the room→server reporting channel — the
  runner does. This "notify channel" redesign makes the channel a runner implementation
  detail so non-UDS runtimes (in-process, worker threads, workerd, remote sandboxes) can
  carry it however they need, while the server core just consumes a stream of notify
  messages plus `stopped(code)`.
  - `subprocess()` is now a **factory**: call it with the argv and it returns a runner
    directly. **Breaking** — migrate `runner((ctx) => subprocess(ctx, cmd))` to
    `subprocess(cmd)`. `options` (`env`, `killTimeoutMs`, `socketDir`) are unchanged in
    spirit.
  - The `runner()` escape hatch's `ctx` gains `onMessage(msg)` — the server's notify-message
    handler, handed to the runner as a callback (channel helpers feed decoded frames to it;
    runners call it directly to synthesize messages on the room's behalf — e.g.
    `{ type: 'error', message }` when a spawn fails) — and keeps `stopped(code)`,
    but **loses** `ctx.socket` / `ctx.socketDir` (the channel's env now comes from a helper,
    not the context). **Breaking** for custom runners — one-line migration: compose a
    channel and spread its env, e.g. `const chan = await notify.uds(ctx); spawn(..., { env: { ...ctx.env, ...chan.env } })`,
    then `chan.close()` in the destructor / on exit.
  - New notify channel helpers, exported from `gatho/server`: `notify.uds(ctx, { socketDir? })`
    returns `{ socketPath, socketDir, env, close() }` — a listening UDS whose decoded frames
    are fed to `ctx.onMessage`. `roomSocketPath` is also exported. This is today's UDS
    implementation relocated out of the server core; runners compose it (built-in
    `subprocess()` does so under the hood).
  - `GATHO_NOTIFY_SOCKET` — a URI (`uds:<path>` / `tcp://host:port?token=…`, or a bare uds
    path) — **replaces** `GATHO_SOCKET`, which is removed outright rather than kept as an
    alias (the notify channel is supervision-local and rooms redeploy with their server, so
    there is no mixed-version window worth carrying a double surface for).
  - `CreateServerOptions.socketDir` is **removed**. It's now an option of `subprocess()` /
    `notify.uds()`, since the runner owns the channel. **Breaking** — move `start({ socketDir })`
    into the runner (`subprocess(cmd, { socketDir })` or `notify.uds(ctx, { socketDir })`).
  - Server startup now waits for the room's first notify message (30s timeout) instead of
    racing a UDS connect against child exit; the heartbeat-stall sweep covers rooms that go
    silent.
- **wire protocol:** heartbeat `metrics` is now **optional**. Internally, `src/common/uds.ts`
  split into `src/common/notify-protocol.ts` (transport-agnostic schema + framing) and the
  listener, and the `RoomMessage` type was renamed `NotifyMessage`.
- **server:** new `notify.tcp(ctx, { host?, advertisedHost? })` channel helper — a loopback
  TCP listener carrying the same frames as UDS, authenticated by a per-room bearer token
  (the room's first frame). For rooms that can't reach a unix socket: containers without a
  mount, remote-ish sandboxes, workerd isolates (via `connect()`). Emits
  `GATHO_NOTIFY_SOCKET=tcp://host:port?token=…`.
- **room:** `start()` accepts the notify channel via `server.notify` — either a `Notifier`
  object (for hosts that construct the link themselves, e.g. in-process hosting or a workerd
  adapter) or a URI string (`uds:<path>` / `tcp://host:port?token=…`). Resolution order:
  `server.notify` → `GATHO_NOTIFY_SOCKET`. `server.socket` is removed along with
  `GATHO_SOCKET`.
- **room:** the room engine is now runtime-neutral — it runs in node, bun, deno, and
  workerd isolates. JWTs moved from `node:crypto` to WebCrypto (signature checks now use
  `crypto.subtle.verify`, and the transport contract's `upgrade()` may be async —
  **breaking** for custom room transports, which must await it); heartbeat process metrics
  are feature-detected and omitted where unavailable; the SIGTERM handler is only installed
  where a process exists; `node:net` is only loaded if a URI notify target is actually
  dialed. The notify wire protocol helpers (`notifyCodec`, `encodeNotifyFrame`,
  `encodeRawFrame`, `createFrameParser`) and the `Notifier` type are exported from
  `gatho/room` for non-node hosts that relay notifications themselves.
- **drivers:** `jwtSign` is async now (WebCrypto) — internal to `reserveClient`, no API
  change for driver users. HMAC `CryptoKey`s are cached per secret (capped FIFO), so the
  per-join / per-upgrade hot paths don't re-import the key.
- **server:** runner `ctx` gains `status()` — `'starting' | 'ready' | 'stopped'`, the room's
  lifecycle as the server core observes it. Lets runners act on state the room can't report
  (e.g. a docker runner surfacing a nonzero exit while still `starting` as a startup
  failure) without intercepting `ctx.onMessage` to sniff messages.
- **server:** new `notify.direct(ctx)` channel — the in-memory case: hands back (a thin gate
  over) the server's message handler for rooms hosted in-process. Completes the
  `notify.{uds,tcp,direct}` namespace.
- **server:** `subprocess()`'s `env` option also accepts a function `(ctx) => env`, restoring
  per-room config forwarding (`ctx.data` → env vars) that the factory form otherwise lost.
- **server:** fixed the stall sweep racing startup — a room's heartbeat clock now starts on
  its first notify message, not at spawn, so slow starts (docker image pulls, cold isolates)
  get the full 30s startup budget instead of being killed at 10s with a double failure
  report.
- **server:** `notify.uds` and `notify.tcp` share one listener core; both now allow a room to
  redial after a dropped connection (previously uds permanently refused reconnects).
- **room:** `server.notify` accepts a bare filesystem path (treated as a uds socket path) —
  `notify: '/tmp/gatho/sock'` works instead of throwing.
- **room:** `wsTransport` loads `ws`/`http` lazily inside `listen()` — `dist/room.js` now has
  zero top-level imports, so bundling `gatho/room` for runtimes that supply their own
  transport (workerd isolates) needs no shims or export conditions, just `external` marks
  for the never-executed dynamic imports.
- **server:** new `roomStartupTimeoutMs` (default 30s) and `roomStallTimeoutMs` (default 10s)
  options — raise the startup budget when spawning is slow (e.g. a docker runner whose first
  spawn pulls the image).
- **server:** `getRoomDetails` / `getAllRoomDetails` now include `status`
  (`'starting' | 'ready' | 'stopped'`) and `lastHeartbeatAt`.

### review-fixes series (robustness + api reshape)

A pass over robustness, ergonomics, and the public API surface. Pre-1.0, so the
breaking changes below ship without compat shims.

- **protocol:** a `PROTOCOL_VERSION` handshake now gates every connection. The client
  stamps its version onto the connect URL; a room with a different version rejects the
  connection with a readable `auth_error` (`protocol version mismatch (client <x>, server <y>)`)
  and closes 4000, instead of a cryptic transport failure. Versions must match exactly —
  no negotiation. **Breaking:** clients and rooms must be redeployed together.
- **client:** two-phase and single-handler reshape of `gatho/client`.
  - `connect(url, handlers)` now takes a **single-handler bag** — one optional callback per
    event (`onOpen`, `onMessage`, `onDrop`, `onReconnect`, `onAuthError`, `onClose`, `onError`).
    **Breaking:** `on`/`off` are removed; the socket is not an app-wide event bus, so app code
    fans out from the single handlers itself.
  - `conn.clientId` — the room-assigned id, delivered on the `session` message and exposed as
    `readonly clientId: string | null` (null until the first session arrives).
  - `open` (and `onOpen`) now fires on **receipt of the `session` message**, not on raw ws open,
    so "open" means authenticated and joined — symmetric with the room's `onJoin`. The minUptime
    timer starts at session receipt.
  - Reliable sends issued while `connecting` are buffered (reusing the reconnect buffer + overflow
    policy) and flushed in order on open. Unreliable sends still drop while not open.
  - Reconnection gives up after a **10-attempt cap** (reset on success) and enters a terminal
    close with cause `reconnect-failed`.
  - `onClose(info)` carries a structured `info.cause`: `consented | auth | session |
    reconnect-failed | buffer-overflow | initial-connect-failed | server`. **Breaking:** the old
    `(code, reason)` close signature is gone; `CloseCause` and `CloseInfo` are exported.
- **room:** two-phase API + per-client verbs + single stable client handles.
  - `create(options)` (from `gatho/room`) builds a room synchronously and returns the handle;
    `await room.start()` brings it online. **Breaking:** replaces the old one-shot `start(options)`.
    Lifecycle callbacks are declared on `create()` and **no longer receive a `room` argument** —
    close over the returned handle.
  - Per-client verbs move onto the client handle: `client.send()`, `client.allowReconnection()`,
    `client.disconnect()`. **Breaking:** `room.send` / `room.allowReconnection` / `room.disconnect`
    are removed. The room keeps `broadcast`, `clients`, `stop`, and identity.
  - Client handles are now **stable for a client's whole lifetime** — one cached object per tracked
    client, so `Map<Client, T>` keys and `===` identity checks work. Verbs on a dead handle
    (post-`onLeave`) are silent no-ops.
  - `client.bufferedAmount` — a readonly getter over the socket's outbound buffer depth (0 when
    disconnected/unobservable), the pacing signal for large-payload streaming.
  - `broadcast(message, { except })` skips specific clients (a `Client` or `Client[]`); excluded
    clients receive nothing, not even a buffered copy on reconnect. The pub/sub fast path is kept
    when `except` is unset.
  - `room.clients` is now **iterable** (`for (const c of room.clients)`), without allocating an
    array per step.
  - `broadcast`/`client.*` before `start()` throw (programming error); post-`stop()` they stay
    silent no-ops. A created-but-unstarted room warns once after ~5s (dev insurance).
- **room (auth/transport hardening):** clients subscribe to the broadcast topic only **after**
  `onAuth` resolves ok (no broadcast leakage during the auth window); a duplicate connection for a
  clientId that already holds a live socket is rejected (`seat already in use`); the ws transport's
  `message`/`close` handlers no-op for a socket that is no longer the current one for its clientId;
  and a client that reconnects while `onDrop` is still awaiting is no longer evicted.
- **sdk / control plane:**
  - `createRoom` now **rejects fast with the real cause**. Drivers publish a room-failure signal
    (redis pub/sub / memory event) that `waitForRoom` subscribes to alongside ready; on failure the
    SDK rejects with a typed **`RoomFailedError`** (extends `GathoError`) instead of burning the
    full `timeoutMs`. The timeout remains a backstop.
  - `CreateRoomOptions.data` and `.tags` are now **optional** (default `{}`), and `JoinOptions.ttl`
    defaults to `30000` (ms).
  - `join({ data })` is capped at 2048 bytes and `join({ tags })` at 512 bytes (serialized);
    exceeding either throws a typed `PayloadTooLargeError`.
- **server:** `start()` **fails fast** when a networked (non-local) driver is used, `serverEndpoint`
  is unset, and the effective bind host is a wildcard (`0.0.0.0`, `::`, unset) — an unroutable
  endpoint would make servers evict each other. Set `serverEndpoint` to a reachable URL. Memory-driver
  oneboxes keep working with defaults.
- **server:** a timed-out `punctuate` heartbeat tick can no longer act on stale conclusions — the run
  callback receives a currency token and no-ops its destructive actions (e.g. `destroyWorker`) if it
  outlived its tick.
- **server:** when a server's driver record is reaped while it is still alive, its still-`ready` local
  rooms are **re-asserted** (re-registered + `roomReady`) instead of being killed by the empty desired
  set. (Room tags from the original `createRoom` are lost on restore — a warn notes this.)
- **drivers:**
  - `ioredis` moved from a dependency to an **optional peer dependency**. The redis driver now lives
    at its own subpath **`gatho/driver/redis`** (`createRedisDriver`); `gatho/driver` (memory driver,
    types, errors) no longer statically pulls in ioredis, so memory-only installs import cleanly
    without it. **Breaking:** import `createRedisDriver` from `gatho/driver/redis`, and
    `npm install ioredis` when you use it.
  - The redis read paths are **pipelined** (`getClientsForRoom`, `listRooms`, `getRoomsForServer`,
    `listServers`) — one round trip per batch instead of N.
  - `staleServerMs` (default `30000`) is now configurable on both drivers — the threshold past which a
    silent server is treated as dead and pruned.
  - Memory driver `roomToInfo` now copies `data` by value (like it already did for tags).
- **messaging (contract):** the `{ reliable: false }` send option is now documented as a
  **transport-agnostic** contract — best-effort, may drop, may reorder, never buffered or
  retransmitted, keep payloads small (~1KB), no ordering guarantee between the reliable and
  unreliable channels. WebSocket's happens-to-be-ordered behaviour is explicitly not promised, and
  WebTransport datagrams will map onto this contract later.
