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
