// e2e tests for driver-level contracts that must hold uniformly across
// memory/redis. consolidated into a single file because the redis test
// setup shares a single backing instance and calls
// `flushdb()` between sub-tests; vitest runs files in parallel by default,
// so spreading these across files causes setup-vs-test races. tests within
// one file run sequentially, which is what we want here.
//
// covers four concerns, each in its own describe block:
//   1. core room/client lifecycle scenarios (room create/destroy, ws round-trip).
//   2. client tags survive sdk.join → driver and surface on getRoom listings.
//   3. driver.connectClient is a self-healing upsert (regression for the
//      partial-update bug where ttl eviction between reserveClient and the
//      `client-connected` ipc would silently drop live peers).
//   4. reserveClient enforces eager payload-size limits on `data` and `tags`,
//      surfacing a typed PayloadTooLargeError instead of letting oversized
//      jwts manifest as opaque websocket-upgrade failures behind proxies.
import { afterEach, describe, expect, it } from 'vitest';
import { allDrivers, type DriverSetup } from './drivers';
import { buildContext, connectAndCollect, sleep, type TestContext } from './helpers';
import type { Driver } from 'gatho/driver';
import {
    PayloadTooLargeError,
    RESERVE_DATA_MAX_BYTES,
    RESERVE_TAGS_MAX_BYTES,
    RoomFailedError,
    RoomTimeoutError,
} from 'gatho/driver';

// minimum scaffolding for tests that drive the driver directly: register a
// server, room, and mark it running so reserveClient is callable without
// spinning up a real room subprocess. unique ids per call so tests don't
// collide if vitest's flushdb cleanup ever lands mid-sequence.
async function setupDriverRoom(driver: Driver) {
    const id = Math.random().toString(36).slice(2, 10);
    const serverId = `srv-${id}`;
    const roomId = `room-${id}`;

    await driver._internal.heartbeat({
        serverId,
        endpoint: 'http://127.0.0.1:0',
        tags: {},
        roomTypes: ['echo'],
    });
    await driver._internal.registerRoom(roomId, 'echo', serverId, {}, {});
    await driver._internal.roomReady(roomId, 'ws://127.0.0.1:0', 'test-secret');

    return { roomId, serverId };
}

const drivers = allDrivers.filter((d: DriverSetup) => d.tags.includes('any'));

// --- 1. core lifecycle scenarios ---------------------------------------------

describe.each(drivers)('lifecycle ($name)', (setup) => {
    let ctx: TestContext;
    let teardownCurrent: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (ctx) await ctx.cleanup();
        if (teardownCurrent) await teardownCurrent();
        teardownCurrent = null;
    });

    it('room lifecycle — create room, verify running, destroy, verify gone', { timeout: 15_000 }, async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        ctx = buildContext(driver);
        const server = await ctx.startServer();
        const serverId = server.serverId;

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

        const fetched = await ctx.sdk.getRoom(room.roomId);
        expect(fetched).not.toBeNull();
        expect(fetched!.status).toBe('running');

        await ctx.sdk.destroyRoom(room.roomId);

        // give the server a moment to clean up the process
        await sleep(500);

        const gone = await ctx.sdk.getRoom(room.roomId);
        expect(gone).toBeNull();
    });

    it('client round-trip — join, connect, send message, receive echo, disconnect', { timeout: 15_000 }, async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
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
        });

        expect(reservation.url).toContain('ws://');
        expect(reservation.url).toContain('token=');

        const { conn, waitForMessages } = connectAndCollect(reservation.url);

        // wait for ws to open before sending
        await sleep(200);

        conn.send(JSON.stringify({ hello: 'world' }));

        const msgs = await waitForMessages(1);
        expect(msgs[0]).toBe(JSON.stringify({ hello: 'world' }));

        conn.close();
    });
});

// --- 2. client tags surface end-to-end via the sdk ---------------------------

describe.each(drivers)('client tags ($name)', (setup) => {
    let ctx: TestContext;

    afterEach(async () => {
        await ctx.cleanup();
    });

    it('tags are visible on ClientInfo via getRoom', { timeout: 15_000 }, async () => {
        const { driver } = await setup.create();
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
        const { driver } = await setup.create();
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
        const { driver } = await setup.create();
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
        const { driver } = await setup.create();
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
        const { driver } = await setup.create();
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
        const { driver } = await setup.create();
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
        const { driver } = await setup.create();
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

// --- 3. connectClient is a self-healing upsert -------------------------------
//
// background: the original redis driver had a partial-update bug where if the
// reservation hash was evicted by ttl in the few-ms window between a room
// verifying the jwt and the resulting `client-connected` ipc message reaching
// the server, the subsequent `hset {status, expiresAt}` would re-create the
// hash *missing* clientId/roomId/tags — and `getClientsForRoom` lazy-prunes
// any hash without a clientId, silently dropping the live peer from the
// driver's view. the same bug fired every 3s on the heartbeat reconciler
// path, drifting the driver record further from truth.
//
// the fix: every `connectClient` call carries the full client identity
// (clientId, roomId, tags) over ipc and writes them as an atomic upsert.
// these tests exercise the contract on *every* driver — the bug lived in
// redis but the contract must hold uniformly so the same room/server code
// can target any driver without surprise.

describe.each(drivers)('connectClient upsert contract ($name)', (setup) => {
    let teardownCurrent: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (teardownCurrent) await teardownCurrent();
        teardownCurrent = null;
    });

    it('happy path: reserve → connect produces a connected client with tags', async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;

        const { roomId } = await setupDriverRoom(driver);
        const reservation = await driver._internal.reserveClient(roomId, 30_000, {}, { team: 'red' });

        await driver._internal.connectClient(reservation.clientId, roomId, { team: 'red' });

        const info = await driver._internal.getRoomInfo(roomId);
        expect(info).not.toBeNull();
        const client = info!.clients.find((c) => c.clientId === reservation.clientId);
        expect(client).toBeDefined();
        expect(client!.status).toBe('connected');
        expect(client!.tags).toEqual({ team: 'red' });
    });

    it('self-heals after the reservation record was lost between reserve and connect', async () => {
        // simulates the eviction race: reservation gets stored, then is wiped
        // (ttl fired in redis, deleted entry in memory) before the room's
        // `client-connected` ipc arrives. the room
        // re-asserts the client identity in the ipc payload — connectClient
        // must reconstitute the record.
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;

        const { roomId } = await setupDriverRoom(driver);
        const reservation = await driver._internal.reserveClient(roomId, 30_000, {}, { squad: 'alpha' });

        // disconnectClient is the closest cross-driver knob for "the record
        // is gone": deletes the hash/row/map entry across all three drivers.
        // stronger than ttl eviction (which leaves a dangling clientsByRoom
        // set entry in redis), so if connect recovers from this it recovers
        // from the narrower ttl race too.
        await driver._internal.disconnectClient(reservation.clientId);

        await driver._internal.connectClient(reservation.clientId, roomId, { squad: 'alpha' });

        const info = await driver._internal.getRoomInfo(roomId);
        expect(info).not.toBeNull();
        const client = info!.clients.find((c) => c.clientId === reservation.clientId);
        expect(client).toBeDefined();
        expect(client!.clientId).toBe(reservation.clientId);
        expect(client!.status).toBe('connected');
        expect(client!.tags).toEqual({ squad: 'alpha' });
    });

    it('is idempotent: repeated connectClient calls converge to the same state', async () => {
        // exercises the heartbeat reconciler path — every 3s the room
        // reports its live client list and the server re-issues
        // connectClient. that loop must be safe to repeat indefinitely.
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;

        const { roomId } = await setupDriverRoom(driver);
        const reservation = await driver._internal.reserveClient(roomId, 30_000, {}, { region: 'us-east' });

        await driver._internal.connectClient(reservation.clientId, roomId, { region: 'us-east' });
        await driver._internal.connectClient(reservation.clientId, roomId, { region: 'us-east' });
        await driver._internal.connectClient(reservation.clientId, roomId, { region: 'us-east' });

        const info = await driver._internal.getRoomInfo(roomId);
        const matches = info!.clients.filter((c) => c.clientId === reservation.clientId);
        expect(matches).toHaveLength(1);
        expect(matches[0].status).toBe('connected');
        expect(matches[0].tags).toEqual({ region: 'us-east' });
    });

    it('reconciler-style heal: evict then re-connect (simulates heartbeat sweep)', async () => {
        // closer simulation of the reconciler path: reservation lands, gets
        // wiped, then a heartbeat tick rediscovers the client and re-issues
        // connectClient. without the upsert fix the driver record would
        // either stay missing (clientsByRoom orphan in redis) or be
        // partially restored (no tags).
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;

        const { roomId } = await setupDriverRoom(driver);
        const reservation = await driver._internal.reserveClient(roomId, 30_000, {}, { role: 'attacker' });

        await driver._internal.disconnectClient(reservation.clientId);

        // simulate the heartbeat reconciler running twice (each tick
        // re-asserts the same identity).
        await driver._internal.connectClient(reservation.clientId, roomId, { role: 'attacker' });
        await driver._internal.connectClient(reservation.clientId, roomId, { role: 'attacker' });

        const info = await driver._internal.getRoomInfo(roomId);
        const client = info!.clients.find((c) => c.clientId === reservation.clientId);
        expect(client).toBeDefined();
        expect(client!.status).toBe('connected');
        expect(client!.tags).toEqual({ role: 'attacker' });
    });
});

// --- 4. reserveClient eagerly enforces payload-size limits -------------------
//
// the reservation jwt travels as a `?token=...` query param on the ws upgrade
// url; oversized payloads silently break the upgrade behind some proxies
// (cloudflare, nginx — clustered around 8 KB request-line limits), so we
// surface the error at the call site instead of letting it manifest as a
// mysterious websocket upgrade failure.

describe.each(drivers)('reserveClient payload size limits ($name)', (setup) => {
    let teardownCurrent: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (teardownCurrent) await teardownCurrent();
        teardownCurrent = null;
    });

    it('throws PayloadTooLargeError when data exceeds RESERVE_DATA_MAX_BYTES', async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        const { roomId } = await setupDriverRoom(driver);

        const oversized = { blob: 'x'.repeat(RESERVE_DATA_MAX_BYTES + 100) };

        await expect(driver._internal.reserveClient(roomId, 30_000, oversized, {})).rejects.toBeInstanceOf(
            PayloadTooLargeError,
        );

        // confirm the error carries machine-readable context — callers
        // should be able to programmatically distinguish data overflow from
        // tag overflow without parsing the message.
        try {
            await driver._internal.reserveClient(roomId, 30_000, oversized, {});
        } catch (err) {
            expect(err).toBeInstanceOf(PayloadTooLargeError);
            const e = err as PayloadTooLargeError;
            expect(e.field).toBe('data');
            expect(e.limitBytes).toBe(RESERVE_DATA_MAX_BYTES);
            expect(e.sizeBytes).toBeGreaterThan(RESERVE_DATA_MAX_BYTES);
            expect(e.code).toBe('payload-too-large');
        }
    });

    it('throws PayloadTooLargeError when tags exceed RESERVE_TAGS_MAX_BYTES', async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        const { roomId } = await setupDriverRoom(driver);

        // many small valid tags that collectively serialize past the budget.
        // tag chars are limited to [a-zA-Z0-9_-] so we can't pack one big
        // value — go wide instead.
        const tags: Record<string, string> = {};
        for (let i = 0; i < 50; i++) {
            tags[`key-${i.toString().padStart(4, '0')}`] = 'a'.repeat(20);
        }

        await expect(driver._internal.reserveClient(roomId, 30_000, {}, tags)).rejects.toBeInstanceOf(
            PayloadTooLargeError,
        );

        try {
            await driver._internal.reserveClient(roomId, 30_000, {}, tags);
        } catch (err) {
            const e = err as PayloadTooLargeError;
            expect(e.field).toBe('tags');
            expect(e.limitBytes).toBe(RESERVE_TAGS_MAX_BYTES);
        }
    });

    it('does not create a reservation when oversized — error is eager', async () => {
        // before the fix the call would have either succeeded (writing the
        // record + minting a doomed jwt) or failed mid-side-effect. either
        // is bad: the eager validator runs *first* so callers see the error
        // before any visible state changes.
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        const { roomId } = await setupDriverRoom(driver);

        const oversized = { blob: 'x'.repeat(RESERVE_DATA_MAX_BYTES + 100) };
        await driver._internal.reserveClient(roomId, 30_000, oversized, {}).catch(() => {});

        const info = await driver._internal.getRoomInfo(roomId);
        expect(info!.clients).toHaveLength(0);
    });

    it('accepts payloads at exactly the limit', async () => {
        // boundary check: the limit is inclusive — a payload that
        // serializes to exactly RESERVE_DATA_MAX_BYTES must be accepted.
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        const { roomId } = await setupDriverRoom(driver);

        // build a string that, with json overhead, lands at exactly the
        // limit: '{"blob":"' + value + '"}' = 10 + value.length bytes.
        const overhead = Buffer.byteLength(JSON.stringify({ blob: '' }));
        const value = 'x'.repeat(RESERVE_DATA_MAX_BYTES - overhead);
        const atLimit = { blob: value };
        expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(RESERVE_DATA_MAX_BYTES);

        await expect(driver._internal.reserveClient(roomId, 30_000, atLimit, {})).resolves.toBeDefined();
    });
});

// --- 5. room-failed signal rejects waitForRoom fast --------------------------
//
// R7: before this, roomFailure just deleted the room and waitForRoom only
// listened for room-ready, so a spawn failure burned the full timeout before
// rejecting with a generic RoomTimeoutError. now roomFailure publishes the
// reason first (redis: a `room-failed:<roomId>` pub/sub channel; memory: an
// event), and waitForRoom subscribes to both ready and failed — rejecting
// immediately with a RoomFailedError carrying the reason. this contract must
// hold uniformly across drivers, so we run it against both.

async function setupRequestedRoom(driver: Driver) {
    const id = Math.random().toString(36).slice(2, 10);
    const serverId = `srv-${id}`;
    const roomId = `room-${id}`;
    await driver._internal.heartbeat({
        serverId,
        endpoint: 'http://127.0.0.1:0',
        tags: {},
        roomTypes: ['echo'],
    });
    await driver._internal.registerRoom(roomId, 'echo', serverId, {}, {});
    return { roomId };
}

describe.each(drivers)('room-failed signal ($name)', (setup) => {
    let teardownCurrent: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (teardownCurrent) await teardownCurrent();
        teardownCurrent = null;
    });

    it('waitForRoom rejects with RoomFailedError carrying the reason', async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        const { roomId } = await setupRequestedRoom(driver);

        // long timeout so the rejection is proven to come from the failed
        // signal, not the timeout backstop. capture the rejection eagerly so
        // there's no window where the promise is settled-but-unobserved (the
        // redis message can dispatch synchronously the moment we publish).
        const settled = driver._internal.waitForRoom(roomId, 60_000).then(
            () => null,
            (e: unknown) => e,
        );
        // give the subscribe a beat to land before publishing (redis pub/sub
        // has no retained messages — a publish before subscribe is lost).
        await sleep(100);
        await driver._internal.roomFailure(roomId, 'missing image');

        const err = await settled;
        expect(err).toBeInstanceOf(RoomFailedError);
        const e = err as RoomFailedError;
        expect(e.code).toBe('room-failed');
        expect(e.roomId).toBe(roomId);
        expect(e.reason).toBe('missing image');
    });

    it('still times out with RoomTimeoutError when neither ready nor failed fires', async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        const { roomId } = await setupRequestedRoom(driver);

        await expect(driver._internal.waitForRoom(roomId, 100)).rejects.toBeInstanceOf(RoomTimeoutError);
    });

    it('resolves normally when the room becomes ready', async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        const { roomId } = await setupRequestedRoom(driver);

        const wait = driver._internal.waitForRoom(roomId, 60_000);
        await sleep(100);
        await driver._internal.roomReady(roomId, 'ws://127.0.0.1:0', 'test-secret');

        const info = await wait;
        expect(info.status).toBe('running');
    });
});

// --- 6. pipelined multi-room / multi-client listings match per-room reads ------
//
// R10: the redis driver batches its read paths into pipelines (one smembers + one
// pipeline of hgetalls) instead of N sequential round-trips. the batched results
// must be byte-identical to what individual getRoomInfo calls produce. this test
// stands up ~10 rooms × ~5 clients on one server and asserts listRooms /
// listServers agree with the per-room getRoomInfo reads across every field. runs
// against both drivers so the contract holds uniformly.

describe.each(drivers)('pipelined listings match per-room reads ($name)', (setup) => {
    let teardownCurrent: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (teardownCurrent) await teardownCurrent();
        teardownCurrent = null;
    });

    it('listRooms and listServers agree with getRoomInfo across 10 rooms × 5 clients', async () => {
        const { driver, teardown } = await setup.create();
        teardownCurrent = teardown;
        const d = driver._internal;

        const id = Math.random().toString(36).slice(2, 8);
        const serverId = `srv-${id}`;
        await d.heartbeat({ serverId, endpoint: 'http://127.0.0.1:0', tags: { region: 'us' }, roomTypes: ['echo'] });

        const roomIds: string[] = [];
        for (let r = 0; r < 10; r++) {
            const roomId = `room-${id}-${r}`;
            roomIds.push(roomId);
            await d.registerRoom(roomId, 'echo', serverId, { idx: r }, { shard: `s${r}` });
            await d.roomReady(roomId, `ws://127.0.0.1:${9000 + r}`, `secret-${r}`);
            for (let c = 0; c < 5; c++) {
                const reservation = await d.reserveClient(roomId, 60_000, {}, { seat: `c${c}` });
                // connect half of them so we exercise both reserved and connected states
                if (c % 2 === 0) {
                    await d.connectClient(reservation.clientId, roomId, { seat: `c${c}` });
                }
            }
        }

        // authoritative per-room reads
        const perRoom = new Map<string, RoomInfoLike>();
        for (const roomId of roomIds) {
            const info = await d.getRoomInfo(roomId);
            expect(info).not.toBeNull();
            perRoom.set(roomId, normalizeRoom(info!));
        }

        // batched listing must reproduce every per-room read exactly
        const listed = await d.listRooms({ serverId });
        expect(listed).toHaveLength(10);
        for (const room of listed) {
            const expected = perRoom.get(room.roomId);
            expect(expected).toBeDefined();
            expect(normalizeRoom(room)).toEqual(expected);
        }

        // and listServers must carry the same rooms, again matching per-room reads
        const servers = await d.listServers();
        const server = servers.find((s) => s.serverId === serverId);
        expect(server).toBeDefined();
        expect(server!.rooms).toHaveLength(10);
        for (const room of server!.rooms) {
            expect(normalizeRoom(room)).toEqual(perRoom.get(room.roomId));
        }
    });
});

// normalize a RoomInfo for order-insensitive comparison: client arrays come back
// in whatever order the driver's index iteration yields, so sort by clientId.
type RoomInfoLike = ReturnType<typeof normalizeRoom>;
function normalizeRoom(info: {
    roomId: string;
    roomType: string;
    serverId: string;
    status: string;
    endpoint: string | null;
    data: Record<string, unknown>;
    tags: Record<string, string>;
    clients: { clientId: string; status: string; tags: Record<string, string> }[];
}) {
    return {
        roomId: info.roomId,
        roomType: info.roomType,
        serverId: info.serverId,
        status: info.status,
        endpoint: info.endpoint,
        data: info.data,
        tags: info.tags,
        clients: [...info.clients]
            .sort((a, b) => a.clientId.localeCompare(b.clientId))
            .map((c) => ({ clientId: c.clientId, status: c.status, tags: c.tags })),
    };
}
