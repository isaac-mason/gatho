![cover](./docs/cover.png)

[![Version](https://img.shields.io/npm/v/gatho?style=for-the-badge)](https://www.npmjs.com/package/gatho)
![GitHub Workflow Status (with event)](https://img.shields.io/github/actions/workflow/status/isaac-mason/gatho/build-and-deploy.yml?style=for-the-badge)
[![Downloads](https://img.shields.io/npm/dt/gatho.svg?style=for-the-badge)](https://www.npmjs.com/package/gatho)

```bash
> npm install github:isaac-mason/gatho
# (npm coming soon!)
```

# gatho

gatho is a javascript multiplayer toolkit for building real-time games and applications.

> ⚠️ gatho is in early alpha, browse and experiment to your heart's content, but expect breaking changes for the time being.

**Features**

- 🕹️ Multiplayer WebSocket rooms
- 🔄 Built-in reconnection with reliable message buffering
- 🧱 Separate process per room by default, with configurable room runners
- 📡 Horizontal scaling with Redis
- 🎯 Flexible SDK for matchmaking and room management
- 🔐 Seat tokens
- 🪶 Unopinionated, adds value where it counts, stays out of your way everywhere else

**API Documentation**

This readme provides curated explanations, guides, and examples to help you get started with gatho.

Auto-generated API documentation can be found at [gatho.dev/docs](https://gatho.dev/docs).

**Changelog**

See the [CHANGELOG.md](./CHANGELOG.md) for a detailed list of changes in each version.

## Table of Contents

<TOC />

## Concepts

A **room** (`gatho/room`) is a shared multiplayer session — a game match, a lobby, a collaborative space. Organise your application and state however you like, use `start` to initialize the room.

A **server** (`gatho/server`) hosts rooms. You run one or more — each registers itself with the driver so the SDK knows it exists and can place rooms on it. You tell the server how to run rooms — the built-in `subprocess()` runner spawns each room as its own child process, but you can run rooms in the same process, in a container, whatever you want. Rooms report their health and status back to the server over a one-way notify channel (a Unix domain socket by default); the runner owns that channel, so a custom runner can carry it however its runtime needs. Running multiple servers gives you horizontal scale.

Your backend uses the **SDK** (`gatho/sdk`) to manage rooms — create, query, and destroy them, tag them for filtering, and call `join()` to mint a short-lived token URL you hand to your client. Tags and client data make it flexible enough to build whatever matchmaking logic you need.

The **driver** (`gatho/driver`) is the shared state store — Redis, Postgres, or in-memory — that lets multiple server instances coordinate.

## Quick Start

First, write a simple room that counts connections and messages:

<Snippet source="./src/quick-start-room.ts" />

Start a gatho server with a driver and tell it how to run your rooms:

<Snippet source="./src/quick-start-server.ts" />

Then you can start rooms using the `gatho/sdk`:

<Snippet source="./src/quick-start-sdk.ts" />

And you can connect to URLs returned by `join()` with `gatho/client`:

<Snippet source="./src/quick-start-client.ts" />

## Examples

- [**chat**](./examples/chat) — a onebox chat app (one process, in-memory driver). Good for getting started and seeing how the pieces fit together without any infra.
- [**ha**](./examples/ha) — example demonstrating multiple gatho servers sharing state via Redis, a separate REST backend, and Caddy in front. This has the "shape" of a production setup but is meant to be run locally for experimentation.

## Server

`gatho/server` is the host process for your rooms. When starting a server you tell it how to run different types of rooms, and it takes care of placement, spawning, health tracking, and shutdown. Run multiple instances against the same driver (e.g. Redis, Postgres) for horizontal scale.

### Runners

A runner knows how to start and stop a single room. The server calls it once per room assignment. The callback you pass to `runner()`:

1. Receives a context with room metadata (`ctx.roomId`, `ctx.data`, `ctx.env`), an `onMessage(msg)` callback (the server's notify-message handler), and a `stopped(code)` callback.
2. Establishes a notify channel the room reports back on — compose a helper like `notify.uds(ctx)` (see below), or call `ctx.onMessage` directly to synthesize messages on the room's behalf (e.g. an `error` when a spawn fails).
3. Spawns the room however you like — child process, container, in-process worker, whatever.
4. Returns a destructor that the server invokes to stop the room.

Call `ctx.stopped(code)` whenever the room exits (crash, clean exit, killed) so the server can reconcile. The destructor owns the shutdown strategy — graceful escalation, a single API call, whatever fits your runtime.

`ctx.env` contains the standard `GATHO_*` environment variables pre-built for the room (room id, type, server id, secret), ready to spread into a process env or pass as docker `-e` flags. The notify channel contributes its own env (`GATHO_NOTIFY_SOCKET`) via the channel helper — spread `chan.env` alongside `ctx.env`.

#### `subprocess()` — child processes

`subprocess()` is a factory for the common case: give it the argv and it returns a runner that spawns a node/bun child process. It sets up a `notify.uds` channel, forwards the standard `GATHO_*` env, wires exit signalling, and handles graceful shutdown (SIGTERM → SIGKILL escalation). Use `options.env` for extra env vars, and `options.socketDir` / `options.killTimeoutMs` to tune the channel and shutdown. Per-room `ctx.data` isn't forwarded automatically — reach for a custom runner when you need that.

<Snippet source="./src/runner-subprocess.ts" />

#### Custom runners

For Docker, microVMs, or any other runtime, write the runner body directly. Compose a notify channel with `notify.uds(ctx)` (or call `ctx.onMessage` yourself), spread `chan.env` into the room's environment, and close the channel when the room exits. The destructor only needs to stop whatever you spawned. Per-room `ctx.data` is available here, so this is also where you forward room-specific config.

<Snippet source="./src/runner-docker.ts" />

### The notify channel

Rooms report to their parent server over a one-way **notify channel** — they send ready signals, heartbeats, and client connect/disconnect events; the server never pushes back over it (stop is delivered out-of-band via the runner's destructor). The runner owns the channel: built-in runners set one up for you, and custom runners compose a helper.

The default helper, `notify.uds(ctx)`, is a Unix domain socket — one per room, created at `socketDir/<roomId>/sock` (`socketDir` defaults to `${os.tmpdir()}/gatho-ipc`, overridable via the helper's options). A UDS is local-only: no TCP/IP stack, no port allocation, no handshake, no TLS — just a file on disk the kernel routes through. That means low latency and low overhead, faster room startup, and an IPC channel never exposed to the network. The only port a room opens is the public WebSocket port clients connect to.

The helper returns `chan.env` — `GATHO_NOTIFY_SOCKET`, a `uds:<path>` URI — which you spread into the room's environment. When running rooms in a sandbox (Docker, microVM, etc.), bind-mount `chan.socketDir` into the container so the socket path resolves on both sides — see the custom runner snippet above.

## Rooms

`gatho/room` is the runtime for a single multiplayer session — a game match, a lobby, a collaborative space. You supply lifecycle callbacks — auth, join, message, drop, reconnect, leave, shutdown — and get back a handle for sending messages to and broadcasting to connected clients.

### Lifecycle

<Snippet source="./src/room-lifecycle.ts" />

### Running Rooms Standalone

By default a room expects to be spawned by a gatho server — it reads `GATHO_*` env vars (set automatically when using `subprocess()`), or takes the same values via `options.server` (e.g. if you are using a custom runner). It opens a Unix domain socket (UDS) back to the parent server to report heartbeats and client connects/disconnects, and it verifies seat tokens minted by `sdk.join()` on every new connection. `start()` throws at startup if no managed context is detected, so a mis-deployed room can't silently accept unauthenticated connections.

For local dev or tests where you want to `bun run room.ts` and connect a client directly, pass `standalone: true`. The room picks a random `roomId`, skips the UDS, and accepts any connection.

<Snippet source="./src/standalone.ts" />

## Messages

gatho is unopinionated about message format — `room.send()` and `room.broadcast()` accept `string | ArrayBuffer | ArrayBufferView`, and `onMessage` receives `string | ArrayBuffer`. For JSON, call `JSON.stringify()` / `JSON.parse()` yourself — gatho stays out of the way.

If you want good performance without sacrificing developer experience, [packcat](https://github.com/isaac-mason/packcat) plays well with gatho. Define schemas once, share them between client and server, and get compact binary encoding with full TypeScript types — no code generation, no IDL files.

<Snippet source="./src/binary-messages.ts" />

## Client

`gatho/client` is a thin WebSocket wrapper that handles the things you'd otherwise build yourself:

- **Automatic reconnection** — on unexpected disconnect the client enters a `reconnecting` state and retries with exponential backoff and jitter.
- **Reliable messaging** — messages sent while reconnecting are buffered (up to 1MB by default) and flushed in order once the connection is restored. Mark a message as `{ reliable: false }` to drop it instead. Future features around backpressure and handling and WebTransport will build on this.
- **Session continuity** — the server issues a session token on first connect. On reconnect the client presents it automatically, so the server sees the same `clientId` and can resume where it left off.
- **Clean close** — `close()` sends a protocol-level leave message so the server knows the disconnect was intentional and skips the reconnection window.

On the server side, opt in to reconnection by calling `room.allowReconnection(client, windowMs)` inside `onDrop`. Reliable messages sent to a disconnected client are buffered (up to `maxBufferBytes`, default 1MB) and flushed automatically on reconnect. If the buffer overflows or the window expires, the client is evicted and `onLeave` fires.

<Snippet source="./src/reconnection.ts" />

## Drivers

Drivers provide the shared state backend used by the server and SDK.

- `createMemoryDriver()` — useful for local dev, tests, and onebox deployments
- `createRedisDriver({ url })` — requires Redis
- `createPostgresDriver({ connectionString })` — requires Postgres (Experimental!)
