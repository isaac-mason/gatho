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
