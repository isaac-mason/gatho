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
