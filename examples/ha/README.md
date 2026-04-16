# ha

This example demonstrates a "highly available" gatho deployment. It starts 3 gatho server instances that communicate with the gatho redis driver, with a separate backend api and react frontend. Caddy handles proxying websocket requests to appropriate rooms.

```
┌──────────┐
│  redis   │  shared state (rooms, servers, seats)
└────┬─────┘
     │
     ├── server-1 (port 3001)   ← bun rooms/src/server.ts, spawns room subprocesses
     ├── server-2 (port 3002)   ← bun rooms/src/server.ts, spawns room subprocesses
     ├── server-3 (port 3003)   ← bun rooms/src/server.ts, spawns room subprocesses
     │
     └── backend (port 4000)    ← rest api (gatho sdk creates rooms, allocates seats)
         
┌──────────┐
│ frontend │  react app (vite, port 5190)
└──────────┘
```
