// e2e tests for client tags — verifies tags passed via sdk.join({ tags })
// are persisted in the driver and exposed on ClientInfo in room/server listings
import { afterEach, describe, expect, it } from 'vitest';
import { memoryDriverSetup } from './drivers';
import { buildContext, connectAndCollect, sleep, type TestContext } from './helpers';

describe('client tags', () => {
    let ctx: TestContext;

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('tags are visible on ClientInfo via getRoom', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        const reservation = await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
            tags: { team: 'red', role: 'attacker' },
        });

        // connect so the client transitions to 'connected'
        const { conn } = connectAndCollect(reservation.url);
        await sleep(500);

        const info = await ctx.sdk.getRoom(room.roomId);
        expect(info).not.toBeNull();

        const client = info!.clients.find((c) => c.clientId === reservation.clientId);
        expect(client).toBeDefined();
        expect(client!.tags).toEqual({ team: 'red', role: 'attacker' });

        conn.close();
    });

    it('missing tags default to empty object', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        // join without tags
        const reservation = await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
        });

        const info = await ctx.sdk.getRoom(room.roomId);
        expect(info).not.toBeNull();

        const client = info!.clients.find((c) => c.clientId === reservation.clientId);
        expect(client).toBeDefined();
        expect(client!.tags).toEqual({});

        // no need to connect — reserved clients should also have tags
    });

    it('tags appear on ClientInfo in getRooms listing', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
            tags: { region: 'us-east' },
        });

        const rooms = await ctx.sdk.getRooms();
        const found = rooms.find((r) => r.roomId === room.roomId);
        expect(found).toBeDefined();
        expect(found!.clients).toHaveLength(1);
        expect(found!.clients[0].tags).toEqual({ region: 'us-east' });
    });

    it('tags appear on ClientInfo in getServers listing', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
            tags: { squad: 'alpha' },
        });

        const servers = await ctx.sdk.getServers();
        const found = servers.find((s) => s.serverId === server.serverId);
        expect(found).toBeDefined();

        const roomInServer = found!.rooms.find((r) => r.roomId === room.roomId);
        expect(roomInServer).toBeDefined();
        expect(roomInServer!.clients).toHaveLength(1);
        expect(roomInServer!.clients[0].tags).toEqual({ squad: 'alpha' });
    });

    it('multiple clients have independent tags', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        const r1 = await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
            tags: { team: 'red' },
        });

        const r2 = await ctx.sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
            tags: { team: 'blue' },
        });

        const info = await ctx.sdk.getRoom(room.roomId);
        expect(info).not.toBeNull();
        expect(info!.clients).toHaveLength(2);

        const c1 = info!.clients.find((c) => c.clientId === r1.clientId);
        const c2 = info!.clients.find((c) => c.clientId === r2.clientId);
        expect(c1!.tags).toEqual({ team: 'red' });
        expect(c2!.tags).toEqual({ team: 'blue' });
    });

    it('rejects invalid tag keys', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        await expect(
            ctx.sdk.join({
                roomId: room.roomId,
                ttl: 30_000,
                tags: { 'invalid key with spaces': 'value' },
            }),
        ).rejects.toThrow(/invalid tag key/);
    });

    it('rejects reserved tag keys starting with underscore', { timeout: 15_000 }, async () => {
        const { driver } = await memoryDriverSetup.create();
        ctx = buildContext(driver);
        const server = await ctx.startServer();

        const room = await ctx.sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        await expect(
            ctx.sdk.join({
                roomId: room.roomId,
                ttl: 30_000,
                tags: { _internal: 'nope' },
            }),
        ).rejects.toThrow(/reserved/);
    });
});
