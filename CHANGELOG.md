# CHANGELOG

## v0.0.1 (Unreleased)

- Initial release!
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
