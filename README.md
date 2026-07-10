![cover](./docs/cover.png)

```bash
> npm install github:isaac-mason/gatho
# (npm coming soon!)
```

# gatho

gatho is a javascript multiplayer toolkit for building real-time games and applications.

> ⚠️ gatho is in early alpha. Browse and experiment freely, but expect breaking changes for now.

**Features**

- 🕹️ Multiplayer WebSocket rooms
- 🔄 Built-in reconnection with reliable message buffering
- 🧱 Separate process per room by default, with configurable room runners
- 📡 Horizontal scaling with Redis
- 🎯 Flexible SDK for matchmaking and room management
- 🔐 Seat tokens
- 🪶 Unopinionated. Adds value where it counts and stays out of your way everywhere else.

**API Documentation**

This readme has explanations, guides, and examples to get you started with gatho.

Auto-generated API documentation can be found at [gatho.dev/docs](https://gatho.dev/docs).

**Changelog**

See the [CHANGELOG.md](./CHANGELOG.md) for a detailed list of changes in each version.

## Table of Contents

- [Concepts](#concepts)
- [Quick Start](#quick-start)
- [Examples](#examples)
- [Server](#server)
- [Rooms](#rooms)
- [Messages](#messages)
- [Client](#client)
- [Backpressure](#backpressure)
- [Drivers](#drivers)

## Concepts

A **room** (`gatho/room`) is a shared multiplayer session: a game match, a lobby, a collaborative space. Organise your application and state however you like, then call `create` to build the room and `await room.start()` to bring it online.

A **server** (`gatho/server`) hosts rooms. You run one or more of them, and each registers itself with the driver so the SDK knows it exists and can place rooms on it. You also tell the server how to run rooms. The built-in `subprocess()` runner spawns each room as its own child process, but you can run rooms in the same process, in a container, or anywhere else. Rooms report their health and status back to the server over a one-way notify channel, which is a Unix domain socket by default. The runner owns that channel, so a custom runner can carry it however its runtime needs. Run multiple servers when you want horizontal scale.

Your backend uses the **SDK** (`gatho/sdk`) to manage rooms. You can create, query, and destroy them, tag them for filtering, and call `join()` to mint a short-lived token URL that you hand to your client. Tags and client data give you enough to build whatever matchmaking logic you need.

The **driver** (`gatho/driver`) is the shared state store that lets multiple server instances coordinate. It can be Redis or in-memory.

## Quick Start

First, write a simple room that counts connections and messages:

```ts
// counter-room.ts
import { create } from 'gatho/room';

let count = 0;

const room = create({
    onAuth: () => ({ ok: true, data: {} }),

    onJoin: (client) => {
        client.send(JSON.stringify({ type: 'count', count }));
    },

    onMessage: (_client, message) => {
        if (typeof message !== 'string') return;

        const parsed = JSON.parse(message) as { type: 'increment' | 'decrement' };

        if (parsed.type === 'increment') {
            count++;
        } else if (parsed.type === 'decrement') {
            count--;
        }

        room.broadcast(JSON.stringify({ type: 'count', count }));
    },
});

await room.start();
```

Start a gatho server with a driver and tell it how to run your rooms:

```ts
// server.ts
import { createRedisDriver } from 'gatho/driver/redis';
import { start, subprocess } from 'gatho/server';

const driver = createRedisDriver({ url: 'redis://localhost:6379' });

await start({
    rooms: {
        counter: subprocess(['bun', 'run', './counter-room.ts']),
    },
    driver,
    roomEndpoint: ({ port }) => `ws://localhost:${port}`,
});
```

Then you can start rooms using the `gatho/sdk`:

```ts
// my-backend.ts
import { createRedisDriver } from 'gatho/driver/redis';
import { createGathoSDK } from 'gatho/sdk';

const gatho = createGathoSDK({ driver: createRedisDriver() });

const servers = await gatho.getServers({ roomTypes: ['counter'] });

// placement policy is yours. here we pick the least-loaded server by current
// room count; you could filter by tags (region, tier), weight by capacity, etc.
const target = servers.sort((a, b) => a.rooms.length - b.rooms.length)[0];

if (!target) {
    throw new Error('no servers available to run a counter room');
}

const room = await gatho.createRoom({
    type: 'counter',
    serverId: target.serverId,
    // data and tags are optional (default {}) — pass them to seed the room's
    // create() data or to categorize the room for later filtering.
});

// ttl is optional too (default 30000ms) — how long the reservation stays valid.
const seat = await gatho.join({ roomId: room.roomId });

console.log(seat.url);
```

A few units and limits worth knowing up front:

- **`join({ ttl })`** is in **milliseconds** and defaults to `30000` (30s) — how long the seat reservation stays valid before the client must connect.
- The reservation token is a **JWT carried in the URL query string** returned by `join()`. URLs have a **~8KB practical limit** across proxies and servers, so keep join `data` compact.
- `join({ data })` is capped at **2048 bytes** and `join({ tags })` at **512 bytes** (serialized); exceed either and `join()` throws a typed **`PayloadTooLargeError`**.

And you can connect to URLs returned by `join()` with `gatho/client`:

```ts
// client.ts
import { connect } from 'gatho/client';

const url = new URLSearchParams(window.location.search).get('url')!;

const room = connect(url, {
    onMessage: (msg) => {
        if (typeof msg !== 'string') return;
        const { count } = JSON.parse(msg) as { count: number };
        console.log('count:', count);
    },
});

room.send(JSON.stringify({ type: 'increment' }));
```

## Examples

- [**chat**](./examples/chat): a onebox chat app (one process, in-memory driver). Good for getting started and seeing how the pieces fit together without any infra.
- [**ha**](./examples/ha): demonstrates multiple gatho servers sharing state via Redis, with a separate REST backend and Caddy in front. It has the shape of a production setup but is meant to be run locally for experimentation.

## Server

`gatho/server` is the host process for your rooms. When starting a server you tell it how to run different types of rooms, and it takes care of placement, spawning, health tracking, and shutdown. Run multiple instances against the same driver (e.g. Redis) for horizontal scale.

With a networked driver, each server publishes its own `serverEndpoint` to its peers and to the SDK. Set it to a URL the rest of your fleet can reach (e.g. `http://10.0.0.5:3000`) — the default derived from a wildcard bind (`0.0.0.0`) is unroutable and would make servers evict each other, so `start()` fails fast in that case. A single-process onebox on the in-memory driver needs no `serverEndpoint`.

### Runners

A runner knows how to start and stop a single room. The server calls it once per room assignment. The callback you pass to `runner()` does four things:

1. It receives a context with room metadata (`ctx.roomId`, `ctx.data`, `ctx.env`), an `onMessage(msg)` callback (the server's notify-message handler), and a `stopped(code)` callback.
2. It establishes a notify channel that the room reports back on. Compose a helper like `notify.uds(ctx)` (see below), or call `ctx.onMessage` directly to synthesize messages on the room's behalf, such as an `error` when a spawn fails.
3. It spawns the room however you like: child process, container, in-process worker, whatever suits you.
4. It returns a destructor that the server invokes to stop the room.

Call `ctx.stopped(code)` whenever the room exits (crash, clean exit, killed) so the server can reconcile. The destructor owns the shutdown strategy, whether that is graceful escalation, a single API call, or whatever fits your runtime.

`ctx.env` contains the standard `GATHO_*` environment variables pre-built for the room (room id, type, server id, secret), ready to spread into a process env or pass as docker `-e` flags. The notify channel contributes its own env var (`GATHO_NOTIFY_SOCKET`) through the channel helper, so spread `chan.env` alongside `ctx.env`.

#### Child processes with `subprocess()`

`subprocess()` is a factory for the common case. Give it the argv and it returns a runner that spawns a node/bun child process. It sets up a `notify.uds` channel, forwards the standard `GATHO_*` env, wires exit signalling, and handles graceful shutdown (SIGTERM first, then SIGKILL if that doesn't take). Use `options.env` for extra env vars, and `options.socketDir` or `options.killTimeoutMs` to tune the channel and shutdown. The `GATHO_*` vars carry room identity, not your gameplay config — to forward per-room config from `createRoom({ data })` into the child, pass `env` as a function of the spawn context: `subprocess(cmd, { env: (ctx) => ({ GAME_MODE: String(ctx.data.gameMode) }) })`.

```ts
import { createMemoryDriver } from 'gatho/driver';
import { start, subprocess } from 'gatho/server';

await start({
    rooms: {
        // subprocess() is a factory: give it the argv and it returns a runner.
        // options.env adds extra env vars alongside the standard GATHO_* set.
        // pass a function to forward per-room config from ctx.data into the
        // child's environment — this is how createRoom({ data }) reaches the room
        // process (GATHO_* covers identity, not your gameplay config).
        game: subprocess(['bun', 'run', './game-room.ts'], {
            env: (ctx) => ({
                REGION: 'eu-west',
                GAME_MODE: String(ctx.data.gameMode ?? 'ffa'),
            }),
        }),
    },
    driver: createMemoryDriver(),
    roomEndpoint: ({ port }) => `ws://localhost:${port}`,
});
```

#### Custom runners

For Docker, microVMs, or any other runtime, write the runner body directly. Compose a notify channel with `notify.uds(ctx)` (or call `ctx.onMessage` yourself), spread `chan.env` into the room's environment, and close the channel when the room exits. The destructor only needs to stop whatever you spawned. Per-room `ctx.data` is available here, so this is also where you forward room-specific config.

```ts
import { spawn } from 'node:child_process';
import { createRedisDriver } from 'gatho/driver/redis';
import { notify, runner, start } from 'gatho/server';

// host and container share this dir so the socket path resolves inside the
// container. it's a notify.uds option now, not a server-wide one.
const SOCKET_DIR = '/tmp/gatho-ipc';

const dockerRunner = runner(async (ctx) => {
    const gameMode = String(ctx.data.gameMode ?? 'classic');

    // establish the notify channel: a uds the room dials back on to report
    // heartbeats and client presence. chan.env carries GATHO_NOTIFY_SOCKET, and
    // chan.socketDir is this room's own socket dir to bind-mount.
    const chan = await notify.uds(ctx, { socketDir: SOCKET_DIR });

    const child = spawn(
        'docker',
        [
            'run',
            // remove the container when it exits
            '--rm',
            // use host networking (simpler setup, you could also do port mapping)
            '--network=host',
            // give the container a name for easier debugging
            '--name',
            `room-${ctx.roomId}`,
            // limit memory
            '--memory',
            '512m',
            // limit CPU
            '--cpus',
            '1',
            // mount only THIS room's socket dir so the room can reach its own socket
            // but not sibling rooms' sockets.
            '-v',
            `${chan.socketDir}:${chan.socketDir}`,
            // forward gatho env + the notify channel env to the container
            ...Object.entries({ ...ctx.env, ...chan.env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
            // set a game mode env var for the container based on ctx.data
            '-e',
            `GAME_MODE=${gameMode}`,
            // our docker image, runs gatho/room's create() + room.start() within
            'my-game-image:latest',
        ],
        { stdio: ['ignore', 'inherit', 'inherit'] },
    );

    // when the child exits, tear down the channel and tell the server the room stopped
    child.on('exit', (code) => {
        chan.close();
        ctx.stopped(code);
    });

    // destructor that stops the container
    return () => {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        timer.unref();
    };
});

await start({
    rooms: { game: dockerRunner },
    driver: createRedisDriver({ url: 'redis://localhost:6379' }),
    roomEndpoint: ({ port }) => `wss://my-host/${port}`,
    tags: { region: 'example', foo: 'bar' },
});
```

### The notify channel

Rooms report to their parent server over a one-way **notify channel**. They send ready signals, heartbeats, and client connect/disconnect events, and the server never pushes back over it. Stop is delivered out-of-band through the runner's destructor instead. The runner owns the channel: built-in runners set one up for you, and custom runners compose a helper.

The default helper, `notify.uds(ctx)`, is a Unix domain socket, one per room, created at `socketDir/<roomId>/sock`. (`socketDir` defaults to `${os.tmpdir()}/gatho-ipc` and can be overridden via the helper's options.) A UDS is local-only: no TCP/IP stack, no port allocation, no handshake, no TLS, just a file on disk that the kernel routes through. That keeps latency and overhead low, speeds up room startup, and keeps the IPC channel off the network entirely. The only port a room opens is the public WebSocket port that clients connect to.

The helper returns `chan.env`, which holds `GATHO_NOTIFY_SOCKET` (a `uds:<path>` URI). Spread that into the room's environment. When running rooms in a sandbox (Docker, microVM, etc.), bind-mount `chan.socketDir` into the container so the socket path resolves on both sides. The custom runner snippet above shows how.

## Rooms

`gatho/room` is the runtime for a single multiplayer session: a game match, a lobby, a collaborative space. You supply lifecycle callbacks (auth, join, message, drop, reconnect, leave, shutdown) and get back a handle for sending messages to connected clients and broadcasting to all of them.

`room.broadcast(message, options?)` fans a message out to every connected client. Pass `{ except }` (a `Client` or `Client[]`) to skip specific clients — the classic "echo to everyone but the sender" case. Excluded clients receive nothing, not even a buffered copy on reconnect. `room.clients` is an iterable collection (`for (const client of room.clients) { … }`) with stable handles: the same `Client` object is returned for a given client for its whole lifetime, so `Map<Client, T>` keys and `===` identity checks work. A handle is dead after `onLeave`; verbs on a dead handle are silent no-ops.

### Lifecycle

```ts
import { create } from 'gatho/room';

const room = create({
    // return { ok: true, data } to accept, { ok: false, error } to reject.
    // callbacks close over `room` — no room parameter is passed. keep the `room`
    // read in a statement (the if-guard below), not in the returned expression.
    onAuth: (joinData: { displayName: string }) => {
        if (room.clients.count() >= 10) return { ok: false, error: 'room is full' };
        return { ok: true, data: { displayName: joinData.displayName } };
    },

    // client is authenticated and in the room
    onJoin: (client) => {
        room.broadcast(JSON.stringify({ type: 'joined', id: client.id }));
    },

    // client sent a message
    onMessage: (client, message) => {
        if (typeof message !== 'string') return;
        room.broadcast(JSON.stringify({ type: 'echo', from: client.id, message }));
    },

    // non-consented disconnect: call allowReconnection to hold the seat
    onDrop: (client) => {
        client.allowReconnection(30_000);
    },

    // client reconnected within the window; buffered messages already flushed
    onReconnect: (client) => {
        client.send(JSON.stringify({ type: 'welcome-back' }));
    },

    // client permanently left: consented close, eviction, or window expired
    onLeave: (client) => {
        room.broadcast(JSON.stringify({ type: 'left', id: client.id }));
    },

    // SIGTERM or room.stop()
    onShutdown: () => {
        console.log('shutting down');
    },
});

await room.start();
```

### Running Rooms Standalone

By default a room expects to be spawned by a gatho server. It reads `GATHO_*` env vars (set automatically when using `subprocess()`), or takes the same values via `options.server` when you are using a custom runner. It opens a Unix domain socket (UDS) back to the parent server to report heartbeats and client connects/disconnects, and it verifies seat tokens minted by `sdk.join()` on every new connection. `create()` throws if no managed context is detected, so a mis-deployed room can't silently accept unauthenticated connections.

A room is two-phase: `create(options)` builds the room synchronously (resolving config, storing your handlers, exposing `room.roomId` immediately), and `await room.start()` brings it online (dialing the notify channel, opening the transport, signalling ready). Lifecycle callbacks are passed to `create()` and no longer receive a `room` argument — reference the `room` handle returned by `create()` directly, and use the per-client verbs `client.send()`, `client.allowReconnection()`, and `client.disconnect()` on the client handle.

For local dev or tests where you want to `bun run room.ts` and connect a client directly, pass `standalone: true`. The room picks a random `roomId`, skips the UDS, and accepts any connection.

```ts
import { create } from 'gatho/room';

// opt in to standalone mode, which skips jwt auth and ipc.
// create() throws if `standalone` is omitted and no GATHO_* env vars are set.
const room = create({
    standalone: true,
    port: 8080,
    onAuth: () => ({ ok: true, data: {} }),
    onMessage: (client, message) => client.send(message),
});

await room.start();
```

## Messages

gatho is format-agnostic — it carries bytes and stays out of the way — but for anything beyond a toy you want one place that defines your whole message protocol and shares it between client and server. The recommended shape is a pair of discriminated unions: a **`ClientPacket`** (client → server) and a **`ServerPacket`** (server → client), each a union over the individual message variants. [packcat](https://github.com/isaac-mason/packcat) plays well with gatho for this: define the schemas once, import them on both ends, and get compact binary encoding with full TypeScript types and exhaustive `switch (packet.type)`. Adding a message is a one-line variant, and the compiler tells both ends what changed. No code generation, no IDL files. This is a convention you own, not a gatho abstraction.

```ts
// shared/protocol.ts
//
// the recommended shape: define ONE ClientPacket union (client → server) and ONE
// ServerPacket union (server → client), share this module between client and
// server, and get compact binary encoding with full TypeScript types. adding a
// message means adding a variant here, and both ends update in lockstep — the
// compiler tells you what you missed. no code generation, no IDL files.

import * as p from 'packcat';

// --- client → server messages ---

const Input = p.object({
    type: p.literal('input'),
    movement: p.list(p.float32(), 2), // [x, y]
});

const Chat = p.object({
    type: p.literal('chat'),
    text: p.string(),
});

// --- server → client messages ---

const Snapshot = p.object({
    type: p.literal('snapshot'),
    tick: p.varuint(),
    players: p.list(
        p.object({
            id: p.varuint(),
            position: p.list(p.float32(), 2), // [x, y]
        }),
    ),
});

const ChatBroadcast = p.object({
    type: p.literal('chat'),
    from: p.varuint(),
    text: p.string(),
});

// one union per direction — the whole protocol surface, discriminated on `type`.
const ClientPacket = p.union('type', [Input, Chat]);
const ServerPacket = p.union('type', [Snapshot, ChatBroadcast]);

export type ClientPacket = p.SchemaType<typeof ClientPacket>;
export type ServerPacket = p.SchemaType<typeof ServerPacket>;

// build the (de)serializers once and reuse them.
export const clientCodec = p.build(ClientPacket);
export const serverCodec = p.build(ServerPacket);

// --- client side ---

// send a typed input, receive a typed snapshot. gatho carries the bytes; packcat
// gives you exhaustive `switch (packet.type)` on both ends.
const inputBytes: Uint8Array<ArrayBufferLike> = clientCodec.pack({ type: 'input', movement: [1, 0] });
console.log('packed client packet:', inputBytes);

function onServerMessage(bytes: ArrayBuffer) {
    const packet: ServerPacket = serverCodec.unpack(new Uint8Array(bytes));
    switch (packet.type) {
        case 'snapshot':
            console.log('tick', packet.tick, 'players', packet.players);
            break;
        case 'chat':
            console.log(`${packet.from}: ${packet.text}`);
            break;
    }
}

// --- server side ---

const snapshotBytes: Uint8Array<ArrayBufferLike> = serverCodec.pack({
    type: 'snapshot',
    tick: 123,
    players: [{ id: 1, position: [10, 20] }],
});
console.log('packed server packet:', snapshotBytes);

function onClientMessage(bytes: ArrayBuffer) {
    const packet: ClientPacket = clientCodec.unpack(new Uint8Array(bytes));
    switch (packet.type) {
        case 'input':
            console.log('movement', packet.movement);
            break;
        case 'chat':
            console.log('chat', packet.text);
            break;
    }
}

// keep the example's helpers referenced so tsc doesn't flag them as unused.
onServerMessage(snapshotBytes.buffer as ArrayBuffer);
onClientMessage(inputBytes.buffer as ArrayBuffer);
```

If you want zero dependencies, the raw path still works: `client.send()` and `room.broadcast()` accept `string | ArrayBuffer | ArrayBufferView`, and `onMessage` receives `string | ArrayBuffer`. For JSON, call `JSON.stringify()` / `JSON.parse()` yourself.

### Reliable and unreliable delivery

By default a message is **reliable**: ordered, delivered, and buffered across a reconnection window (see [Client](#client) below). Pass `{ reliable: false }` to `client.send()` / `room.broadcast()` (and `send()` on the client) for **unreliable** delivery — best-effort, meant for high-frequency state that's obsolete the moment the next update ships (cursor positions, input samples). The contract is deliberately transport-agnostic:

- an unreliable message **MAY be dropped** and **MAY be reordered**;
- it is **never buffered or retransmitted** — if the peer is disconnected, it drops outright;
- keep unreliable payloads **small** (aim for ~1KB);
- there is **no ordering guarantee between** the reliable and unreliable channels.

On today's WebSocket transport an unreliable message happens to arrive ordered and intact while the socket stays connected — but that is a property of WebSocket, **not a promise of the contract**, so don't rely on it. WebTransport datagrams will map onto this same unreliable contract later.

## Client

`gatho/client` is a thin WebSocket wrapper that handles the things you'd otherwise build yourself. `connect(url, handlers)` takes a single-handler bag — one callback per event (`onOpen`, `onMessage`, `onDrop`, `onReconnect`, `onAuthError`, `onClose`, `onError`), all optional — and returns a connection with `send()`, `close()`, `state`, and `clientId`:

- **Automatic reconnection.** On an unexpected disconnect the client enters a `reconnecting` state and retries with exponential backoff and jitter. After **10 consecutive failed attempts** it gives up and closes for good — `onClose` fires with cause `'reconnect-failed'`, the signal to re-matchmake. The counter resets on any successful reconnect.
- **Reliable messaging.** Messages sent while `connecting` or `reconnecting` are buffered (up to 1MB by default) and flushed in order once the connection is (re)established. Mark a message `{ reliable: false }` to drop it instead — see [Reliable and unreliable delivery](#reliable-and-unreliable-delivery).
- **Session continuity.** The server issues a session token on first connect. On reconnect the client presents it automatically, so the server sees the same `clientId` and can resume where it left off. `conn.clientId` is that id — `null` until the first `session` message arrives (i.e. until `onOpen`).
- **Clean close.** `close()` sends a protocol-level leave message so the server knows the disconnect was intentional and skips the reconnection window.

**Version handshake.** The client stamps its gatho protocol version onto the connect URL, and the room rejects a mismatch fast and loud: the connection closes with an `auth_error` reading `protocol version mismatch (client <x>, server <y>)` rather than a cryptic transport failure. Client and server gatho versions must match — there is no negotiation. Redeploy rooms and clients together.

**Close causes.** `onClose(info)` receives `info.cause` so you can react without decoding raw WebSocket codes:

| cause | meaning |
| --- | --- |
| `consented` | the app called `close()` — an intentional departure |
| `auth` | the room rejected the initial connect (`auth_error`) |
| `session` | the room rejected our session token on reconnect |
| `reconnect-failed` | reconnection gave up after the 10-attempt cap |
| `buffer-overflow` | the outbound reliable buffer exceeded its 1MB cap |
| `initial-connect-failed` | the first WebSocket closed before a session arrived |
| `server` | the server closed a live, authenticated connection |

On the server side, opt in to reconnection by calling `client.allowReconnection(windowMs)` inside `onDrop`. Reliable messages sent to a disconnected client are buffered (up to 1MB) and flushed automatically on reconnect. If the buffer overflows or the window expires, the client is evicted and `onLeave` fires.

The client's `onOpen` handler and the room's `onJoin` fire at the same protocol instant — receipt of the session message — so "joined" means the same thing on both ends. The same holds for `onMessage`, `onDrop`, and `onReconnect`, which name the same events viewed from each end.

**Outbound backpressure.** Gatho exposes each socket's unflushed outbound buffer via `client.bufferedAmount` but ships no automatic eviction policy — bursty payloads (a voxel world sync) must not be killed by a threshold gatho guessed at, so the pacing and eviction decisions are yours. See [Backpressure](#backpressure) below.

```ts
import { create } from 'gatho/room';

const room = create({
    onAuth: () => ({ ok: true, data: {} }),

    onDrop: (client) => {
        client.allowReconnection(30_000); // hold seat for 30s
    },

    onReconnect: (client) => {
        client.send(JSON.stringify({ type: 'welcome-back' }));
    },
});

await room.start();
```

## Backpressure

When you write to a socket faster than the peer can read, the unsent bytes pile up in the OS send buffer. Left unchecked that means unbounded memory growth on the server and rising latency for every other message to that peer. `client.bufferedAmount` exposes the depth of that buffer (in bytes, `0` when disconnected or when the transport can't report it). gatho ships this **signal only** — no automatic policy — because the right response depends entirely on your workload. A voxel world-sync that briefly parks megabytes in the buffer is perfectly healthy; a policy that evicted it on a raw byte threshold would be wrong.

There are two things you typically do with the signal.

**1. Pace large sends.** Rather than pushing a big snapshot in one call, stream it in chunks and check `client.bufferedAmount` between them, deferring more writes while the buffer is above a high-water mark. This is the voxel world-sync pattern — the send self-throttles to whatever the peer can actually absorb.

**2. Build your own stall-eviction policy.** If you do want to drop peers that can't keep up, the key insight is that **buffered ≠ stalled**. An instantaneous threshold misfires on bursts: a healthy peer receiving that big snapshot briefly shows a huge buffer. The discriminator is **drain progress** — sweep `room.clients` periodically, remember each client's last buffered depth, and only `client.disconnect()` a peer whose buffer is both high *and* not shrinking across sweeps. A stalled peer's buffer stays high; a busy-but-healthy peer's falls as the OS flushes it.

(For readers who'd rather adopt an automatic policy: uWebSockets caps the buffer with `maxBackpressure` and drops the socket past it; Bun's `ws.send()` returns a negative value under backpressure so you can stop feeding it. gatho exposes the raw signal and lets you choose.)

```ts
import { create } from 'gatho/room';

const room = create({
    onAuth: () => ({ ok: true, data: {} }),
});

// --- (a) pacing a large send ---
//
// a big world snapshot (voxel chunks, a full lobby state) can be tens of MB. push
// it all at once and it piles up in the socket's outbound buffer faster than the
// peer can drain it — memory balloons and latency for everything else spikes.
// instead, stream it in chunks and check client.bufferedAmount between chunks,
// yielding while the buffer is high so the socket can drain.

const HIGH_WATER = 1 << 20; // 1MB — pause new chunks above this
const CHUNK_BYTES = 64 * 1024;

async function streamSnapshot(clientId: string, snapshot: Uint8Array): Promise<void> {
    for (let offset = 0; offset < snapshot.byteLength; offset += CHUNK_BYTES) {
        // re-fetch the handle each iteration — the client may have left mid-stream.
        const client = room.clients.get(clientId);
        if (!client) return;

        // wait for the buffer to drain below the high-water mark before queueing
        // more. a real impl would await an event/timer; a poll keeps the example
        // dependency-free.
        while (client.bufferedAmount > HIGH_WATER) {
            await new Promise((r) => setTimeout(r, 16));
            if (!room.clients.has(clientId)) return;
        }

        client.send(snapshot.subarray(offset, offset + CHUNK_BYTES));
    }
}

// --- (b) your own stall-eviction policy ---
//
// gatho ships client.bufferedAmount and NO automatic eviction. a naive
// "disconnect anyone above N bytes" misfires: a bursty payload (that world
// snapshot) briefly parks megabytes in the buffer for a perfectly healthy peer.
// buffered != stalled. the discriminator is DRAIN PROGRESS — a stalled peer's
// buffer stays high WITHOUT shrinking across a sweep; a busy-but-healthy peer's
// buffer falls as the OS flushes it.
//
// so: sweep periodically, remember each client's last buffered depth, and only
// evict a peer whose buffer is both high AND not lower than last time. (prior
// art for an automatic version: uWS's maxBackpressure caps the buffer and drops
// the socket; Bun's ws.send() returns a negative value on backpressure so you can
// stop feeding it. we expose the raw signal and let you pick the policy.)

const STALL_LIMIT = 4 << 20; // 4MB — only consider eviction above this
const lastBuffered = new Map<string, number>();

function sweepForStalls() {
    for (const client of room.clients) {
        const buffered = client.bufferedAmount;
        const previous = lastBuffered.get(client.id) ?? 0;

        // high AND not draining (>= last sweep) → the peer isn't keeping up.
        if (buffered > STALL_LIMIT && buffered >= previous) {
            client.disconnect();
            lastBuffered.delete(client.id);
            continue;
        }

        lastBuffered.set(client.id, buffered);
    }
}

setInterval(sweepForStalls, 1000);

// keep the streaming helper referenced so tsc doesn't flag it as unused.
void streamSnapshot;

await room.start();
```

## Drivers

Drivers provide the shared state backend used by the server and SDK.

- `createMemoryDriver()` (from `gatho/driver`): useful for local dev, tests, and onebox deployments
- `createRedisDriver({ url })` (from `gatho/driver/redis`): requires Redis. `ioredis` is an optional peer dependency — install it (`npm i ioredis`) only when you use this driver; `gatho/driver` (memory driver, types, errors) never pulls it in.

Both drivers accept `staleServerMs` (default `30000`) — how long a server may go without a heartbeat before its peers treat it as dead and prune it. Raise it if your servers legitimately pause longer than 30s (heavy GC, migration windows); lower it for faster failover.

`createRoom()` rejects fast on failure. If the room's process fails to boot — a bad argv, a missing container image, a crash on startup — the driver publishes a room-failure signal and `createRoom()` rejects with a typed **`RoomFailedError`** carrying the real reason, rather than burning the full `timeoutMs`. The timeout remains only as a backstop for a room that goes silent without reporting.
