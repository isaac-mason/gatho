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

- [Concepts](#concepts)
- [Quick Start](#quick-start)
- [Examples](#examples)
- [Server](#server)
- [Rooms](#rooms)
- [Messages](#messages)
- [Client](#client)
- [Drivers](#drivers)

## Concepts

A **room** (`gatho/room`) is a shared multiplayer session — a game match, a lobby, a collaborative space. Organise your application and state however you like, use `start` to initialize the room.

A **server** (`gatho/server`) hosts rooms. You run one or more — each registers itself with the driver so the SDK knows it exists and can place rooms on it. You tell the server how to run rooms — the built-in `subprocess()` helper spawns each room as its own child process, but you can run rooms in the same process, in a container, whatever you want. Rooms report their health and status back to the server over a Unix domain socket. Running multiple servers gives you horizontal scale.

Your backend uses the **SDK** (`gatho/sdk`) to manage rooms — create, query, and destroy them, tag them for filtering, and call `join()` to mint a short-lived token URL you hand to your client. Tags and client data make it flexible enough to build whatever matchmaking logic you need.

The **driver** (`gatho/driver`) is the shared state store — Redis, Postgres, or in-memory — that lets multiple server instances coordinate.

## Quick Start

First, write a simple room that counts connections and messages:

```ts
// counter-room.ts
import { auth, start } from 'gatho/room';

let count = 0;

await start({
    onAuth: () => auth.ok(),

    onJoin: (room, client) => {
        room.send(client, JSON.stringify({ type: 'count', count }));
    },

    onMessage: (room, _client, message) => {
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
```

Start a gatho server with a driver and tell it how to run your rooms:

```ts
// server.ts
import { createRedisDriver } from 'gatho/driver';
import { runner, start, subprocess } from 'gatho/server';

const driver = createRedisDriver({ url: 'redis://localhost:6379' });

await start({
    rooms: {
        counter: runner((ctx) => subprocess(ctx, ['bun', 'run', './counter-room.ts'])),
    },
    driver,
    roomEndpoint: ({ port }) => `ws://localhost:${port}`,
});
```

Then you can start rooms using the `gatho/sdk`:

```ts
// my-backend.ts
import { createRedisDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';

const gatho = createGathoSDK({ driver: createRedisDriver() });

const servers = await gatho.getServers({ roomTypes: ['counter'] });

if (servers.length === 0) {
    throw new Error('no servers available to run a counter room');
}

const room = await gatho.createRoom({
    type: 'counter',
    serverId: servers[0].serverId,
    data: {
        /* any custom data you want to start the room with */
    },
    tags: {
        /* any tags you want to give the room */
    },
});

const seat = await gatho.join({ roomId: room.roomId, ttl: 30_000 });

console.log(seat.url);
```

And you can connect to URLs returned by `join()` with `gatho/client`:

```ts
// client.ts
import { connect } from 'gatho/client';

const url = new URLSearchParams(window.location.search).get('url')!;
const room = connect(url);

room.on('message', (msg) => {
    if (typeof msg !== 'string') return;
    const { count } = JSON.parse(msg) as { count: number };
    console.log('count:', count);
});

room.send(JSON.stringify({ type: 'increment' }));
```

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

```ts
import { createMemoryDriver } from 'gatho/driver';
import { runner, start, subprocess } from 'gatho/server';

await start({
    rooms: {
        game: runner((ctx) =>
            subprocess(ctx, ['bun', 'run', './game-room.ts'], {
                env: {
                    GAMEMODE: ctx.data.gamemode as string,
                },
            }),
        ),
    },
    driver: createMemoryDriver(),
    roomEndpoint: ({ port }) => `ws://localhost:${port}`,
});
```

#### Custom runners

For Docker, microVMs, or any other runtime, write the runner body directly. The destructor only needs to stop whatever you spawned.

```ts
import { spawn } from 'node:child_process';
import { createRedisDriver } from 'gatho/driver';
import { runner, start } from 'gatho/server';

const dockerRunner = runner((ctx) => {
    const gameMode = String(ctx.data.gameMode ?? 'classic');

    const child = spawn('docker', [
        'run', '--rm', '--network=host',
        '--name', `room-${ctx.roomId}`,
        '--memory', '512m',
        '-v', '/tmp/gatho-ipc:/tmp/gatho-ipc',
        ...Object.entries(ctx.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        '-e', `GAME_MODE=${gameMode}`,
        'my-game-image:latest',
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    child.on('exit', (code) => ctx.stopped(code));

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
    tags: { region: 'us-east-1' },
});
```

## Rooms

`gatho/room` is the runtime for a single multiplayer session — a game match, a lobby, a collaborative space. You supply lifecycle callbacks — auth, join, message, drop, reconnect, leave, shutdown — and get back a handle for sending messages to and broadcasting to connected clients.

### Lifecycle

```ts
import { auth, start } from 'gatho/room';

await start({
    // return auth.ok(data) to accept, auth.fail(reason) to reject
    onAuth: (room, joinData: { displayName: string }) => {
        if (room.clients.count() >= 10) return auth.fail('room is full');
        return auth.ok({ displayName: joinData.displayName });
    },

    // client is authenticated and in the room
    onJoin: (room, client) => {
        room.broadcast(JSON.stringify({ type: 'joined', id: client.id }));
    },

    // client sent a message
    onMessage: (room, client, message) => {
        if (typeof message !== 'string') return;
        room.broadcast(JSON.stringify({ type: 'echo', from: client.id, message }));
    },

    // non-consented disconnect — call allowReconnection to hold the seat
    onDrop: (room, client) => {
        room.allowReconnection(client, 30_000);
    },

    // client reconnected within the window — buffered messages already flushed
    onReconnect: (room, client) => {
        room.send(client, JSON.stringify({ type: 'welcome-back' }));
    },

    // client permanently left — consented close, eviction, or window expired
    onLeave: (room, client) => {
        room.broadcast(JSON.stringify({ type: 'left', id: client.id }));
    },

    // SIGTERM or room.stop()
    onShutdown: () => {
        console.log('shutting down');
    },
});
```

### Running Rooms Standalone

When a room is spawned by a server, it reads `GATHO_*` env vars, connects IPC to the parent for heartbeats and client tracking, and validates seat tokens minted by `sdk.join()`. With no `GATHO_*` env vars present, the room runs standalone — it picks a random `roomId`, skips IPC, and accepts any connection. Useful for local dev and tests where you just want to `bun run room.ts` and connect a client directly.

## Messages

gatho is unopinionated about message format — `room.send()` and `room.broadcast()` accept `string | ArrayBuffer | ArrayBufferView`, and `onMessage` receives `string | ArrayBuffer`. For JSON, call `JSON.stringify()` / `JSON.parse()` yourself — gatho stays out of the way.

If you want good performance without sacrificing developer experience, [packcat](https://github.com/isaac-mason/packcat) plays well with gatho. Define schemas once, share them between client and server, and get compact binary encoding with full TypeScript types — no code generation, no IDL files.

```ts
// shared/protocol.ts

// define your message schemas once, use them on both client and server

import * as p from 'packcat';

// client → server
const PlayerInput = p.object({
    type: p.literal('input'),
    movement: p.list(p.float32()),
});

// server → client
const GameState = p.object({
    type: p.literal('snapshot'),
    tick: p.varuint(),
    players: p.list(
        p.object({
            id: p.varuint(),
            position: p.list(p.float32(), 2), // [x, y]
        }),
    ),
});

const ServerMessage = p.union('type', [GameState]);
const ClientMessage = p.union('type', [PlayerInput]);

export type ServerMessage = p.SchemaType<typeof ServerMessage>;
// { type: 'snapshot', tick: number, players: { id: number, position: [number, number] }[] }

export type ClientMessage = p.SchemaType<typeof ClientMessage>;
// { type: 'input', movement: [number, number] }

const ServerMessageSerDes = p.build(ServerMessage);
const ClientMessageSerDes = p.build(ClientMessage);

const exampleServerMessage: Uint8Array<ArrayBufferLike> = ServerMessageSerDes.pack({
    type: 'snapshot',
    tick: 123,
    players: [
        { id: 1, position: [10, 20] },
        { id: 2, position: [30, 40] },
    ],
});

console.log('packed server message:', exampleServerMessage);

const unpackedServerMessage: ServerMessage = ServerMessageSerDes.unpack(exampleServerMessage);
console.log('unpacked server message:', unpackedServerMessage.tick, unpackedServerMessage.players);

const exampleClientMessage: Uint8Array<ArrayBufferLike> = ClientMessageSerDes.pack({
    type: 'input',
    movement: [1, 0],
});

console.log('packed client message:', exampleClientMessage);

const unpackedClientMessage: ClientMessage = ClientMessageSerDes.unpack(exampleClientMessage);
console.log('unpacked client message:', unpackedClientMessage.movement);
```

## Client

`gatho/client` is a thin WebSocket wrapper that handles the things you'd otherwise build yourself:

- **Automatic reconnection** — on unexpected disconnect the client enters a `reconnecting` state and retries with exponential backoff and jitter.
- **Reliable messaging** — messages sent while reconnecting are buffered (up to 1MB by default) and flushed in order once the connection is restored. Mark a message as `{ reliable: false }` to drop it instead. Future features around backpressure and handling and WebTransport will build on this.
- **Session continuity** — the server issues a session token on first connect. On reconnect the client presents it automatically, so the server sees the same `clientId` and can resume where it left off.
- **Clean close** — `close()` sends a protocol-level leave message so the server knows the disconnect was intentional and skips the reconnection window.

On the server side, opt in to reconnection by calling `room.allowReconnection(client, windowMs)` inside `onDrop`. Reliable messages sent to a disconnected client are buffered (up to `maxBufferBytes`, default 1MB) and flushed automatically on reconnect. If the buffer overflows or the window expires, the client is evicted and `onLeave` fires.

```ts
import { auth, start } from 'gatho/room';

await start({
    onAuth: () => auth.ok(),

    onDrop: (room, client) => {
        room.allowReconnection(client, 30_000); // hold seat for 30s
    },

    onReconnect: (room, client) => {
        room.send(client, JSON.stringify({ type: 'welcome-back' }));
    },
});
```

## Drivers

Drivers provide the shared state backend used by the server and SDK.

- `createMemoryDriver()` — useful for local dev, tests, and onebox deployments
- `createRedisDriver({ url })` — requires Redis
- `createPostgresDriver({ connectionString })` — requires Postgres (Experimental!)
