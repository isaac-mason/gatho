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

<TOC />

## Concepts

A **room** (`gatho/room`) is a shared multiplayer session — a game match, a lobby, a collaborative space. State lives in module scope and clients connect directly over WebSocket.

A **server** (`gatho/server`) hosts rooms. You run one or more — each registers itself with the driver so the SDK knows it exists and can place rooms on it. You tell the server how to run rooms — by default `subprocess()` spawns each room as its own process, but you can run rooms in the same process, in a container, or anywhere else. Rooms report their health and status back to the server over a Unix domain socket. Running multiple servers gives you horizontal scale.

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

## Room Lifecycle

<Snippet source="./src/room-lifecycle.ts" />

## Reconnection

Call `room.allowReconnection(client, windowMs)` inside `onDrop` to hold a client's seat while they're disconnected. Reliable messages sent during the window are buffered (up to 1MB per client) and flushed automatically on reconnect. Exceeding the buffer limit or window causes the client to be dropped.

<Snippet source="./src/reconnection.ts" />

## Drivers

Drivers provide the shared state backend used by the server and SDK.

- `createMemoryDriver()` — useful for local dev, tests, and onebox deployments
- `createRedisDriver({ url })` — requires Redis
- `createPostgresDriver({ connectionString })` — requires Postgres (Experimental!)
