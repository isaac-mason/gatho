![cover](./docs/cover.png)

[![Version](https://img.shields.io/npm/v/gatho?style=for-the-badge)](https://www.npmjs.com/package/gatho)
![GitHub Workflow Status (with event)](https://img.shields.io/github/actions/workflow/status/isaac-mason/gatho/build-and-deploy.yml?style=for-the-badge)
[![Downloads](https://img.shields.io/npm/dt/gatho.svg?style=for-the-badge)](https://www.npmjs.com/package/gatho)

```bash
> npm install gatho
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

A **server** (`gatho/server`) hosts rooms. You run one or more — each registers itself with the driver so the SDK knows it exists and can place rooms on it. You tell the server how to run rooms — the built-in `subprocess()` helper spawns each room as its own child process, but you can run rooms in the same process, in a container, whatever you want. Rooms report their health and status back to the server over a Unix domain socket. Running multiple servers gives you horizontal scale.

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

A runner is a function that knows how to start and stop a single room. The server calls it once per room assignment. The callback you pass to `runner()`:

1. Receives a context with room metadata (`ctx.roomId`, `ctx.data`, `ctx.env`) and a `ctx.stopped(code)` callback.
2. Spawns the room however you like — child process, container, in-process worker, whatever.
3. Returns a destructor that the server invokes to stop the room.

Call `ctx.stopped(code)` whenever the room exits (crash, clean exit, killed) so the server can reconcile. The destructor owns the shutdown strategy — graceful escalation, a single API call, whatever fits your runtime.

`ctx.env` contains the standard `GATHO_*` environment variables pre-built for the room, ready to spread into a process env or pass as docker `-e` flags.

#### `subprocess()` — child processes

`subprocess()` is a helper for the common case: spawn a node/bun child process. It's called from inside a `runner()` callback, forwards `ctx.env`, wires exit signalling, and handles graceful shutdown (SIGTERM → SIGKILL escalation). Use `options.env` to pass extra env vars or forward fields from `ctx.data`.

<Snippet source="./src/runner-subprocess.ts" />

#### Custom runners

For Docker, microVMs, or any other runtime, write the runner body directly. The destructor only needs to stop whatever you spawned.

<Snippet source="./src/runner-docker.ts" />

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
