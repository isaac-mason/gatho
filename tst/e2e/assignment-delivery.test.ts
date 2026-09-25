import type { Driver } from 'gatho/driver';
import { createMemoryDriver, RoomFailedError, RoomTimeoutError, ServerNotFoundError } from 'gatho/driver';
import { createRedisDriver } from 'gatho/driver/redis';
import { createGathoSDK } from 'gatho/sdk';
import type { RoomRunner, Server } from 'gatho/server';
import { start, subprocess } from 'gatho/server';
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { roomScripts, sleep, waitUntil } from './helpers';

type CreatedDriver = {
    driver: Driver;
    // every key the driver holds (redis only), so a test can prove nothing leaked
    storedKeys: () => Promise<string[]>;
    teardown: () => Promise<void>;
};

type Setup = { name: string; create: (staleServerMs?: number) => Promise<CreatedDriver> };

// own db and prefix: other e2e files flushdb theirs, and pub/sub channels span dbs
const redisPrefix = 'assignment:{assignment}:';

const setups: Setup[] = [
    {
        name: 'memory',
        create: async (staleServerMs) => {
            const driver = createMemoryDriver({ staleServerMs });
            return { driver, storedKeys: async () => [], teardown: async () => driver.destroy?.() };
        },
    },
    {
        name: 'redis',
        create: async (staleServerMs) => {
            const base = process.env.GATHO_TEST_REDIS_URL ?? 'redis://localhost:16379';
            const client = new Redis(`${base}/1`);
            await client.flushdb();
            const driver = createRedisDriver({ client, prefix: redisPrefix, staleServerMs });
            return {
                driver,
                storedKeys: () => client.keys(`${redisPrefix}*`),
                teardown: async () => {
                    driver.destroy?.();
                    await client.flushdb();
                    client.disconnect();
                },
            };
        },
    },
];

// counts spawns so tests can assert the at-most-once-per-process spawn guarantee
function countingRunner(inner: RoomRunner): { runner: RoomRunner; spawns: () => number } {
    let spawns = 0;
    return {
        runner: {
            spawn(ctx) {
                spawns++;
                return inner.spawn(ctx);
            },
        },
        spawns: () => spawns,
    };
}

describe.each(setups)('assignment delivery ($name)', (setup) => {
    let server: Server | null = null;
    let teardown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        await server?.stop();
        server = null;
        await teardown?.();
        teardown = null;
    });

    async function startServer(driver: Driver, runner: RoomRunner): Promise<Server> {
        return start({
            rooms: { echo: runner },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            host: '127.0.0.1',
            port: 0,
            heartbeatIntervalMs: 250,
        });
    }

    it('spawns a room whose assignment push was lost, within a few heartbeats', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const { driver } = created;

        // every push is lost: the server subscribes, but nothing is ever delivered
        driver._internal.subscribeRoomAssignments = async () => () => {};

        server = await startServer(driver, subprocess(['bun', 'run', roomScripts.echo]));
        const sdk = createGathoSDK({ driver });

        const startedAt = Date.now();
        const room = await sdk.createRoom({ type: 'echo', serverId: server.serverId, timeoutMs: 15_000 });

        expect(room.status).toBe('running');
        // one heartbeat interval to notice, plus the room's own boot
        expect(Date.now() - startedAt).toBeLessThan(5_000);
    }, 20_000);

    it('spawns a room that crashes on startup exactly once while its failure report is in flight', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const { driver } = created;

        // hold the failure report across many ticks, while the room is still 'requested'
        const reportFailure = driver._internal.roomFailure.bind(driver._internal);
        driver._internal.roomFailure = async (roomId, reason) => {
            await sleep(1_500);
            return reportFailure(roomId, reason);
        };

        const counted = countingRunner(subprocess(['bun', '-e', 'process.exit(1)']));
        server = await startServer(driver, counted.runner);
        const sdk = createGathoSDK({ driver });

        await expect(sdk.createRoom({ type: 'echo', serverId: server.serverId, timeoutMs: 15_000 })).rejects.toBeInstanceOf(
            RoomFailedError,
        );

        // several more reconcile ticks after the failure landed
        await sleep(1_000);
        expect(counted.spawns()).toBe(1);
    }, 20_000);

    it('does not leave a room running when it becomes ready after the caller gave up', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const { driver } = created;

        const counted = countingRunner(subprocess(['bun', 'run', roomScripts.echo]));
        const startedServer = await startServer(driver, counted.runner);
        server = startedServer;
        const sdk = createGathoSDK({ driver });

        // the caller gives up long before any room could boot, and unregisters it
        await expect(sdk.createRoom({ type: 'echo', serverId: startedServer.serverId, timeoutMs: 1 })).rejects.toBeInstanceOf(
            RoomTimeoutError,
        );

        await waitUntil(async () => counted.spawns() === 1, 5_000);
        await waitUntil(async () => startedServer.getAllRoomDetails().length === 0, 10_000);
        await sleep(500);

        expect(startedServer.getAllRoomDetails()).toEqual([]);
        expect(await driver._internal.listRooms()).toEqual([]);
        expect(counted.spawns()).toBe(1);
    }, 20_000);

    it('keeps a room pushed between the heartbeat snapshot and the destroy sweep', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const { driver } = created;
        const startedServer = await startServer(driver, subprocess(['bun', 'run', roomScripts.echo]));
        server = startedServer;

        // this tick's snapshot predates a room that is assigned and spawned before its sweep
        const roomId = 'pushed-mid-tick';
        const heartbeat = driver._internal.heartbeat.bind(driver._internal);
        let assigned = false;
        driver._internal.heartbeat = async (options) => {
            const snapshot = await heartbeat(options);
            if (assigned) return snapshot;
            assigned = true;
            await driver._internal.registerRoom(roomId, 'echo', startedServer.serverId, {}, {}, 60_000);
            await waitUntil(async () => startedServer.getRoomDetails(roomId) !== null, 2_000);
            return snapshot;
        };

        await waitUntil(async () => assigned && startedServer.getRoomDetails(roomId) !== null, 5_000);
        const room = await driver._internal.waitForRoom(roomId, 10_000, Promise.resolve());
        expect(room.status).toBe('running');

        // and later ticks, whose snapshots include it, leave it alone too
        await sleep(750);
        expect(startedServer.getRoomDetails(roomId)?.status).toBe('ready');
    }, 20_000);

    it('rejects createRoom for an unknown server without leaving an unhandled rejection behind', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const sdk = createGathoSDK({ driver: created.driver });

        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            await expect(sdk.createRoom({ type: 'echo', serverId: 'no-such-server', timeoutMs: 50 })).rejects.toBeInstanceOf(
                ServerNotFoundError,
            );
            // well past the wait's own timeout
            await sleep(200);
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});

describe.each(setups)('server record lifecycle ($name)', (setup) => {
    let teardown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        await teardown?.();
        teardown = null;
    });

    const heartbeatOptions = { serverId: 'srv-1', endpoint: 'http://127.0.0.1:1', tags: {}, roomTypes: ['echo'] };

    it('reports registered on the heartbeat that recreates a record removed since the last one', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const driver = created.driver._internal;

        expect((await driver.heartbeat(heartbeatOptions)).registered).toBe(true);
        expect((await driver.heartbeat(heartbeatOptions)).registered).toBe(false);

        // a reap lands between two heartbeats
        await driver.unregisterServer('srv-1');

        expect((await driver.heartbeat(heartbeatOptions)).registered).toBe(true);
    });

    it('refuses to reap a server whose heartbeat is fresh', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const driver = created.driver._internal;

        await driver.heartbeat(heartbeatOptions);

        expect(await driver.reapServer('srv-1')).toBe(false);
        expect(await driver.getServer('srv-1')).not.toBeNull();
    });

    it('reports requested rooms with their status in the desired set', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const driver = created.driver._internal;

        await driver.heartbeat(heartbeatOptions);
        await driver.registerRoom('room-a', 'echo', 'srv-1', { n: 1 }, {}, 60_000);
        await driver.registerRoom('room-b', 'echo', 'srv-1', {}, {}, 60_000);
        await driver.roomReady('room-b', 'ws://127.0.0.1:2', 'secret');

        const { desiredRooms } = await driver.heartbeat(heartbeatOptions);
        const byId = new Map(desiredRooms.map((room) => [room.roomId, room]));

        expect(byId.get('room-a')).toEqual({ roomId: 'room-a', roomType: 'echo', data: { n: 1 }, status: 'requested' });
        expect(byId.get('room-b')?.status).toBe('running');
    });

    it('drops a requested room once its ttl lapses', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const driver = created.driver._internal;

        await driver.heartbeat(heartbeatOptions);
        await driver.registerRoom('room-a', 'echo', 'srv-1', {}, {}, 100);
        await sleep(250);

        expect(await driver.getRoomInfo('room-a')).toBeNull();
        expect(await driver.roomReady('room-a', 'ws://127.0.0.1:2', 'secret')).toBe(false);
        // and the refused ready wrote nothing back, not even a partial record getRoomInfo would skip
        expect(await driver.getRoomInfo('room-a')).toBeNull();
        expect((await created.storedKeys()).filter((key) => key.includes('room-a'))).toEqual([]);
    });

    it('reaps a stale server together with every room and client it owns, and nothing else', async () => {
        const created = await setup.create(200);
        teardown = created.teardown;
        const driver = created.driver._internal;

        await driver.heartbeat(heartbeatOptions);
        await driver.registerRoom('room-a', 'echo', 'srv-1', {}, {}, 60_000);
        await driver.registerRoom('room-b', 'echo', 'srv-1', {}, {}, 60_000);
        await driver.roomReady('room-b', 'ws://127.0.0.1:2', 'secret');
        const reservation = await driver.reserveClient('room-b', 60_000);
        await driver.connectClient(reservation.clientId, 'room-b', {});

        // srv-1 goes stale; srv-2 heartbeats fresh and owns a room of its own
        await sleep(300);
        await driver.heartbeat({ ...heartbeatOptions, serverId: 'srv-2', endpoint: 'http://127.0.0.1:3' });
        await driver.registerRoom('room-c', 'echo', 'srv-2', {}, {}, 60_000);

        expect(await driver.reapServer('srv-1')).toBe(true);

        expect(await driver.getServer('srv-1')).toBeNull();
        expect(await driver.getRoomInfo('room-a')).toBeNull();
        expect(await driver.getRoomInfo('room-b')).toBeNull();
        expect((await driver.listRooms()).map((room) => room.roomId)).toEqual(['room-c']);
        expect((await driver.listServers()).map((server) => server.serverId)).toEqual(['srv-2']);
        const owned = new RegExp(`srv-1|room-a|room-b|${reservation.clientId}`);
        expect((await created.storedKeys()).filter((key) => owned.test(key))).toEqual([]);
    });

    it('rejects registering a room on an unknown server with the shared ServerNotFoundError, writing nothing', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const driver = created.driver._internal;

        await expect(driver.registerRoom('room-a', 'echo', 'ghost', {}, {}, 60_000)).rejects.toBeInstanceOf(ServerNotFoundError);

        expect(await driver.getRoomInfo('room-a')).toBeNull();
        expect((await created.storedKeys()).filter((key) => key.includes('room-a'))).toEqual([]);
    });

    it('rejects a ttl that is not a positive whole number before writing anything', async () => {
        const created = await setup.create();
        teardown = created.teardown;
        const driver = created.driver._internal;
        await driver.heartbeat(heartbeatOptions);

        for (const ttlMs of [1.5, 0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
            await expect(driver.registerRoom('room-a', 'echo', 'srv-1', {}, {}, ttlMs)).rejects.toBeInstanceOf(RangeError);
        }

        expect(await driver.getRoomInfo('room-a')).toBeNull();
        expect((await created.storedKeys()).filter((key) => key.includes('room-a'))).toEqual([]);
    });
});
