![cover](./docs/cover.png)

[![Version](https://img.shields.io/npm/v/gatho?style=for-the-badge)](https://www.npmjs.com/package/gatho)
![GitHub Workflow Status (with event)](https://img.shields.io/github/actions/workflow/status/isaac-mason/gatho/build-and-deploy.yml?style=for-the-badge)
[![Downloads](https://img.shields.io/npm/dt/gatho.svg?style=for-the-badge)](https://www.npmjs.com/package/gatho)

```bash
> npm install gatho
```

# gatho

gatho is a javascript multiplayer toolkit for building real-time games and applications.

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
- [Client](#client)
- [Messages](#messages)
- [Room Lifecycle](#room-lifecycle)
- [Drivers](#drivers)

## Concepts

A **room** (`gatho/room`) is a shared multiplayer session — a game match, a lobby, a collaborative space. Organise statee

A **server** (`gatho/server`) hosts rooms. You run one or more — each registers itself with the driver so the SDK knows it exists and can place rooms on it. You tell the server how to run rooms — by default `subprocess()` spawns each room as its own process, but you can run rooms in the same process, in a container, or anywhere else. Rooms report their health and status back to the server over a Unix domain socket. Running multiple servers gives you horizontal scale.

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
import { createServer, subprocess } from 'gatho/server';

const driver = createRedisDriver({ url: 'redis://localhost:6379' });

const server = createServer({
    rooms: {
        counter: subprocess(['bun', 'run', './counter-room.ts']),
    },
    driver,
    roomEndpoint: ({ port }) => `ws://localhost:${port}`,
    tags: {},
});

await server.start();
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

## Room Lifecycle

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

## Drivers

Drivers provide the shared state backend used by the server and SDK.

- `createMemoryDriver()` — useful for local dev, tests, and onebox deployments
- `createRedisDriver({ url })` — requires Redis
- `createPostgresDriver({ connectionString })` — requires Postgres (Experimental!)
