// e2e tests for join data flow — verifies data passed via sdk.join({ data })
// is delivered to the room's onAuth callback as joinData
import { afterEach, describe, expect, it } from 'vitest';
import { memoryDriverSetup } from './drivers';
import { buildContext, connectAndCollect, sleep, type TestContext } from './helpers';

describe('join data', () => {
    let ctx: TestContext;

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('join data is delivered to room via onAuth', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'join-data',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        // join with custom data
        const reservation = await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
            data: { role: 'admin', level: 42 },
        });

        const { waitForMessages, conn } = connectAndCollect(reservation.url);

        const msgs = await waitForMessages(1);
        expect(msgs[0]).toBe(
            JSON.stringify({
                type: 'join-data',
                data: { role: 'admin', level: 42 },
            }),
        );

        conn.close();
    });

    it('join without data delivers empty object as joinData', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'join-data',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        // join without data
        const reservation = await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
        });

        const { waitForMessages, conn } = connectAndCollect(reservation.url);

        const msgs = await waitForMessages(1);
        expect(msgs[0]).toBe(
            JSON.stringify({
                type: 'join-data',
                data: {},
            }),
        );

        conn.close();
    });

    it('join data with nested objects is preserved', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'join-data',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        const nestedData = {
            profile: { name: 'alice', prefs: { color: 'blue' } },
            scores: [100, 200, 300],
            active: true,
        };

        const reservation = await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
            data: nestedData,
        });

        const { waitForMessages, conn } = connectAndCollect(reservation.url);

        const msgs = await waitForMessages(1);
        expect(msgs[0]).toBe(
            JSON.stringify({
                type: 'join-data',
                data: nestedData,
            }),
        );

        conn.close();
    });
});
