import { createMemoryDriver } from 'gatho/driver';
import { start, subprocess } from 'gatho/server';

await start({
    rooms: {
        // subprocess() is a factory: give it the argv and it returns a runner.
        // options.env adds extra env vars alongside the standard GATHO_* set.
        game: subprocess(['bun', 'run', './game-room.ts'], {
            env: { REGION: 'eu-west' },
        }),
    },
    driver: createMemoryDriver(),
    roomEndpoint: ({ port }) => `ws://localhost:${port}`,
});
