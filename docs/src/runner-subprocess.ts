import { createMemoryDriver } from 'gatho/driver';
import { start, subprocess } from 'gatho/server';

await start({
    rooms: {
        // subprocess() is a factory: give it the argv and it returns a runner.
        // options.env adds extra env vars alongside the standard GATHO_* set.
        // pass a function to forward per-room config from ctx.data into the
        // child's environment. this is how createRoom({ data }) reaches the room
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
