import { createRedisDriver } from 'gatho/driver/redis';
import { createGathoSDK } from 'gatho/sdk';
import type { Server } from 'gatho/server';
import { start, subprocess } from 'gatho/server';
import Redis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomScripts, sleep, waitUntil } from './helpers';
import { startTcpProxy, type TcpProxy } from './tcp-proxy';

const redisUrl = new URL(process.env.GATHO_TEST_REDIS_URL ?? 'redis://localhost:16379');
const redisHost = redisUrl.hostname;
const redisPort = Number(redisUrl.port);
// own db and prefix: other e2e files flushdb theirs, and pub/sub channels span dbs
const db = 2;
const prefix = 'subscriber:{subscriber}:';
// long enough that no server in these tests is reaped for heartbeating slowly
const staleServerMs = 120_000;

function captureLogLines(): { lines: () => string[]; restore: () => void } {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
        lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return write(chunk, ...(rest as []));
    });
    return { lines: () => lines, restore: () => spy.mockRestore() };
}

describe('redis subscriber liveness', () => {
    const cleanups: (() => Promise<void> | void)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        cleanups.length = 0;
        const admin = new Redis(redisPort, redisHost, { db });
        await admin.flushdb();
        admin.disconnect();
    });

    // host behind a breakable proxy, sdk direct; a minute-long heartbeat means any spawn here came from the push
    async function hostBehindProxy(): Promise<{ proxy: TcpProxy; server: Server; sdk: ReturnType<typeof createGathoSDK> }> {
        const proxy = await startTcpProxy(redisHost, redisPort);
        cleanups.push(() => proxy.close());

        const hostClient = new Redis(proxy.port, '127.0.0.1', { db });
        const hostDriver = createRedisDriver({ client: hostClient, prefix, staleServerMs });
        cleanups.push(() => {
            hostDriver.destroy?.();
            hostClient.disconnect();
        });

        const server = await start({
            rooms: { echo: subprocess(['bun', 'run', roomScripts.echo]) },
            driver: hostDriver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            host: '127.0.0.1',
            port: 0,
            heartbeatIntervalMs: 60_000,
        });
        cleanups.push(() => server.stop());

        const sdkClient = new Redis(redisPort, redisHost, { db });
        const sdkDriver = createRedisDriver({ client: sdkClient, prefix, staleServerMs });
        cleanups.push(() => {
            sdkDriver.destroy?.();
            sdkClient.disconnect();
        });

        // main connection first, then the subscriber opened by the room subscription
        await waitUntil(async () => proxy.connections.length === 2, 5_000);
        return { proxy, server, sdk: createGathoSDK({ driver: sdkDriver }) };
    }

    it('heals a subscriber whose server side was dropped while the client side stayed open', async () => {
        const { proxy, server, sdk } = await hostBehindProxy();
        const logs = captureLogLines();
        cleanups.push(() => logs.restore());

        const [, subscriberConnection] = proxy.connections;
        subscriberConnection.dropUpstreamSilently();

        // the canary misses and the subscriber reconnects through a fresh connection
        await waitUntil(async () => proxy.connections.length === 3, 25_000);
        expect(logs.lines().some((line) => line.includes('subscriber canary missed, reconnecting'))).toBe(true);

        // assignments reach the host by push again; its heartbeat is a minute away
        const startedAt = Date.now();
        const room = await sdk.createRoom({ type: 'echo', serverId: server.serverId, timeoutMs: 10_000 });
        expect(room.status).toBe('running');
        expect(Date.now() - startedAt).toBeLessThan(5_000);
    }, 45_000);

    it('heals a subscriber whose connection went silent in both directions', async () => {
        const { proxy, server, sdk } = await hostBehindProxy();

        const [, subscriberConnection] = proxy.connections;
        subscriberConnection.blackhole();

        await waitUntil(async () => proxy.connections.length === 3, 25_000);

        const room = await sdk.createRoom({ type: 'echo', serverId: server.serverId, timeoutMs: 10_000 });
        expect(room.status).toBe('running');
    }, 45_000);

    it('does not reconnect a healthy subscriber when it is the main connection that went silent', async () => {
        // a driver alone, not a server: a server's stop() would wait on the silent main connection
        const proxy = await startTcpProxy(redisHost, redisPort);
        cleanups.push(() => proxy.close());
        const client = new Redis(proxy.port, '127.0.0.1', { db });
        const driver = createRedisDriver({ client, prefix, staleServerMs });
        cleanups.push(() => {
            driver.destroy?.();
            client.disconnect();
        });
        await driver._internal.subscribeRoomAssignments('srv-1', () => {});
        await waitUntil(async () => proxy.connections.length === 2, 5_000);
        const logs = captureLogLines();
        cleanups.push(() => logs.restore());

        const [mainConnection] = proxy.connections;
        mainConnection.blackhole();

        // the canary's PUBLISH never resolves, so no canary is ever counted as missed
        await sleep(16_000);
        expect(proxy.connections.length).toBe(2);
        expect(logs.lines().some((line) => line.includes('subscriber canary missed'))).toBe(false);
    }, 30_000);

    it('keeps the canary receiving when the first SUBSCRIBE on a fresh subscriber fails', async () => {
        const proxy = await startTcpProxy(redisHost, redisPort);
        cleanups.push(() => proxy.close());
        // with no offline queue, a SUBSCRIBE issued before the subscriber connects rejects
        const client = new Redis(proxy.port, '127.0.0.1', { db, enableOfflineQueue: false });
        await new Promise<void>((resolve) => client.once('ready', () => resolve()));
        const driver = createRedisDriver({ client, prefix, staleServerMs });
        cleanups.push(() => {
            driver.destroy?.();
            client.disconnect();
        });
        const logs = captureLogLines();
        cleanups.push(() => logs.restore());

        await expect(driver._internal.subscribeRoomAssignments('srv-1', () => {})).rejects.toThrow();

        // longer than the canary's detection bound: a deaf canary would have reconnected by now
        await sleep(20_000);
        expect(logs.lines().some((line) => line.includes('subscriber canary missed'))).toBe(false);
        expect(proxy.connections.length).toBe(2);
    }, 40_000);

    it('closes its own subscriber on destroy, releasing every subscription', async () => {
        const client = new Redis(redisPort, redisHost, { db });
        const driver = createRedisDriver({ client, prefix, staleServerMs });
        cleanups.push(() => client.disconnect());
        const admin = new Redis(redisPort, redisHost, { db });
        cleanups.push(() => admin.disconnect());
        const channel = `${prefix}room-assigned:srv-destroy`;
        const subscribers = async () => Number((await admin.pubsub('NUMSUB', channel))[1]);

        await driver._internal.subscribeRoomAssignments('srv-destroy', () => {});
        expect(await subscribers()).toBe(1);

        driver.destroy?.();
        await waitUntil(async () => (await subscribers()) === 0, 2_000);
        // the caller's client is untouched
        expect(await client.ping()).toBe('PONG');
    });

    it('keeps a healthy subscriber connected', async () => {
        const { proxy } = await hostBehindProxy();
        // three canary rounds with nothing broken
        await sleep(16_000);
        expect(proxy.connections.length).toBe(2);
    }, 30_000);

    it('names a server that is not listening when a room is assigned to it', async () => {
        const client = new Redis(redisPort, redisHost, { db });
        const driver = createRedisDriver({ client, prefix, staleServerMs });
        cleanups.push(() => {
            driver.destroy?.();
            client.disconnect();
        });
        const logs = captureLogLines();
        cleanups.push(() => logs.restore());

        // a server record with no subscriber behind it
        await driver._internal.heartbeat({
            serverId: 'deaf-server',
            endpoint: 'http://127.0.0.1:1',
            tags: {},
            roomTypes: ['echo'],
        });
        await driver._internal.registerRoom('room-1', 'echo', 'deaf-server', {}, {}, 60_000);

        const warning = logs.lines().find((line) => line.includes('room assigned but server not subscribed'));
        expect(warning).toContain('deaf-server');
        expect(warning).toContain('room-1');
    });

    it('resubscribes a channel whose first SUBSCRIBE failed instead of treating it as subscribed', async () => {
        // with no offline queue, a SUBSCRIBE issued before the subscriber connects rejects
        const client = new Redis(redisPort, redisHost, { db, enableOfflineQueue: false });
        await new Promise<void>((resolve) => client.once('ready', () => resolve()));
        const driver = createRedisDriver({ client, prefix, staleServerMs });
        cleanups.push(() => {
            driver.destroy?.();
            client.disconnect();
        });

        const received: string[] = [];
        await expect(driver._internal.subscribeRoomAssignments('srv-1', (room) => received.push(room.roomId))).rejects.toThrow();

        // once the subscriber is up, subscribing again must really SUBSCRIBE
        await sleep(300);
        await driver._internal.subscribeRoomAssignments('srv-1', (room) => received.push(room.roomId));

        await driver._internal.heartbeat({ serverId: 'srv-1', endpoint: 'http://127.0.0.1:1', tags: {}, roomTypes: ['echo'] });
        await driver._internal.registerRoom('room-1', 'echo', 'srv-1', {}, {}, 60_000);
        await waitUntil(async () => received.length > 0, 2_000);

        expect(received).toEqual(['room-1']);
    });
});

describe('redis liveness uses redis time', () => {
    afterEach(async () => {
        vi.useRealTimers();
        const admin = new Redis(redisPort, redisHost, { db });
        await admin.flushdb();
        admin.disconnect();
    });

    it('judges staleness by redis time, not the clock of whoever is asking', async () => {
        const client = new Redis(redisPort, redisHost, { db });
        const driver = createRedisDriver({ client, prefix, staleServerMs: 1_000 });
        const heartbeatOptions = { serverId: 'srv-1', endpoint: 'http://127.0.0.1:1', tags: {}, roomTypes: ['echo'] };

        vi.useFakeTimers({ toFake: ['Date'] });
        const realNow = Date.now();

        // heartbeat from a host whose clock is ten minutes slow
        vi.setSystemTime(realNow - 10 * 60_000);
        await driver._internal.heartbeat(heartbeatOptions);

        // judged by a leader whose clock is ten minutes fast
        vi.setSystemTime(realNow + 10 * 60_000);
        expect((await driver._internal.listServers()).map((s) => s.serverId)).toEqual(['srv-1']);
        expect(await driver._internal.listStaleServers()).toEqual([]);
        expect(await driver._internal.reapServer('srv-1')).toBe(false);

        // and it does go stale once redis's own clock has moved past the threshold
        vi.useRealTimers();
        await sleep(1_200);
        expect((await driver._internal.listStaleServers()).map((s) => s.serverId)).toEqual(['srv-1']);
        expect(await driver._internal.reapServer('srv-1')).toBe(true);
        expect(await driver._internal.getServer('srv-1')).toBeNull();

        driver.destroy?.();
        client.disconnect();
    });
});
