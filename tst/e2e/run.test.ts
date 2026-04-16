// e2e test suite — runs scenarios against each driver
import { afterEach, describe, expect, it } from 'vitest';
import { allDrivers } from './drivers';
import { buildContext, connectAndCollect, sleep, type TestContext } from './helpers';

type Scenario = {
    name: string;
    tags: string[];
    run: (ctx: TestContext) => Promise<void>;
};

const scenarios: Scenario[] = [
    {
        name: 'room lifecycle — create room, verify running, destroy, verify gone',
        tags: ['any'],
        run: async (ctx) => {
            const server = await ctx.startServer();
            const serverId = server.serverId;

            // create room
            const room = await ctx.sdk.createRoom({
                type: 'echo',
                serverId,
                data: {},
                tags: {},
            });

            expect(room.roomId).toBeTruthy();
            expect(room.status).toBe('running');
            expect(room.roomType).toBe('echo');
            expect(room.serverId).toBe(serverId);

            // verify it exists via sdk
            const fetched = await ctx.sdk.getRoom(room.roomId);
            expect(fetched).not.toBeNull();
            expect(fetched!.status).toBe('running');

            // destroy it
            await ctx.sdk.destroyRoom(room.roomId);

            // give the server a moment to clean up the process
            await sleep(500);

            // verify it's gone
            const gone = await ctx.sdk.getRoom(room.roomId);
            expect(gone).toBeNull();
        },
    },
    {
        name: 'client round-trip — join, connect, send message, receive echo, disconnect',
        tags: ['any'],
        run: async (ctx) => {
            const server = await ctx.startServer();

            // create room
            const room = await ctx.sdk.createRoom({
                type: 'echo',
                serverId: server.serverId,
                data: {},
                tags: {},
            });

            // join as a user
            const reservation = await ctx.sdk.join({
                roomId: room.roomId,
                ttl: 30_000,
            });

            expect(reservation.url).toContain('ws://');
            expect(reservation.url).toContain('token=');

            // connect and send a message
            const { conn, waitForMessages } = connectAndCollect(reservation.url);

            // wait for ws to open before sending
            await sleep(200);

            conn.send(JSON.stringify({ hello: 'world' }));

            // wait for the echo
            const msgs = await waitForMessages(1);
            expect(msgs[0]).toBe(JSON.stringify({ hello: 'world' }));

            conn.close();
        },
    },
];

// run all scenarios against each driver
for (const driverSetup of allDrivers) {
    describe(driverSetup.name, () => {
        let ctx: TestContext | null = null;
        let teardownDriver: (() => Promise<void>) | null = null;

        afterEach(async () => {
            if (ctx) {
                await ctx.cleanup();
                ctx = null;
            }
            if (teardownDriver) {
                await teardownDriver();
                teardownDriver = null;
            }
        });

        for (const scenario of scenarios) {
            const applicable = scenario.tags.every((t) => driverSetup.tags.includes(t));
            if (!applicable) continue;

            it(scenario.name, { timeout: 15_000 }, async () => {
                const { driver, teardown } = await driverSetup.create();
                teardownDriver = teardown;
                ctx = buildContext(driver);
                await scenario.run(ctx);
            });
        }
    });
}
