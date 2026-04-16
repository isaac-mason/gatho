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
- [Room Lifecycle](#room-lifecycle)
- [Reconnection](#reconnection)
- [Drivers](#drivers)

## Concepts

A **room** (`gatho/room`) is a shared multiplayer session — a game match, a lobby, a collaborative space. State lives in module scope and clients connect directly over WebSocket.

A **server** (`gatho/server`) hosts rooms. You run one or more — each registers itself with the driver so the SDK knows it exists and can place rooms on it. You tell the server how to run rooms — by default `subprocess()` spawns each room as its own process, but you can run rooms in the same process, in a container, or anywhere else. Rooms report their health and status back to the server over a Unix domain socket. Running multiple servers gives you horizontal scale.

Your backend uses the **SDK** (`gatho/sdk`) to manage rooms — create, query, and destroy them, tag them for filtering, and call `join()` to mint a short-lived token URL you hand to your client. Tags and client data make it flexible enough to build whatever matchmaking logic you need. Gatho tries to stay out of this and instead offers a "CRUD API" for javascript rooms that handles the hard parts for you. 

The **driver** (`gatho/driver`) is the shared state store — Redis, Postgres, or in-memory — that lets multiple server instances coordinate.

## Quick Start

First, write a simple room that counts connections and messages:

```ts
// room.ts
import { auth, start } from 'gatho/room';

let count = 0;

await start({
    onAuth: () => auth.ok(),

    onJoin: (room, client) => {
        room.send(client, { type: 'count', count });
    },

    onMessage: (room, _client, message: { type: 'increment' | 'decrement' }) => {
        if (message.type === 'increment') count++;
        if (message.type === 'decrement') count--;
        room.broadcast({ type: 'count', count });
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
// backend.ts
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
    data: { /* any custom data you want to start the room with */ },
    tags: { /* any tags you want to give the room */ },
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
    const { count } = msg as { count: number };
    console.log('count:', count);
});

room.send({ type: 'increment' });
```

## Room Lifecycle

```ts
import { auth, start } from 'gatho/room';

await start({
    // return auth.ok(data) to accept, auth.fail(reason) to reject
    onAuth: (joinData: { displayName: string }, room) => {
        if (room.clients.count() >= 10) return auth.fail('room is full');
        return auth.ok({ displayName: joinData.displayName });
    },

    // client is authenticated and in the room
    onJoin: (room, client) => {
        room.broadcast({ type: 'joined', id: client.id });
    },

    // client sent a message
    onMessage: (room, client, message: { type: string }) => {
        room.broadcast({ type: 'echo', from: client.id, message });
    },

    // non-consented disconnect — call allowReconnection to hold the seat
    onDrop: (room, client) => {
        room.allowReconnection(client, 30_000);
    },

    // client reconnected within the window — buffered messages already flushed
    onReconnect: (room, client) => {
        room.send(client, { type: 'welcome-back' });
    },

    // client permanently left — consented close, eviction, or window expired
    onLeave: (room, client) => {
        room.broadcast({ type: 'left', id: client.id });
    },

    // SIGTERM or room.stop()
    onShutdown: () => {
        console.log('shutting down');
    },
});
```

## Reconnection

Call `room.allowReconnection(client, windowMs)` inside `onDrop` to hold a client's seat while they're disconnected. Reliable messages sent during the window are buffered (up to 1MB per client) and flushed automatically on reconnect. Exceeding the buffer limit or window causes the client to be dropped.

```ts
import { auth, start } from 'gatho/room';

await start({
    onAuth: () => auth.ok(),

    onDrop: (room, client) => {
        room.allowReconnection(client, 30_000); // hold seat for 30s
    },

    onReconnect: (room, client) => {
        room.send(client, { type: 'welcome-back' });
    },
});
```

## Drivers

Drivers provide the shared state backend used by the server and SDK.

- `createMemoryDriver()` — useful for local dev, tests, and onebox deployments
- `createRedisDriver({ url })` — requires Redis
- `createPostgresDriver({ connectionString })` — requires Postgres (Experimental!)
