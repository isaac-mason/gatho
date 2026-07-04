// startup + stall timing for the notify-channel rework.
//
// drives the server core through the memory driver + sdk. rooms are FAKE
// in-process runners built with runner(): instead of spawning a process, each
// runner captures its SpawnContext and lets the test drive notify messages into
// ctx.onMessage (directly or on a timer). this isolates the server's startup gate
// and stall sweep from any real process.

import type { Driver } from 'gatho/driver';
import { createMemoryDriver } from 'gatho/driver';
import { createGathoSDK, type GathoSDK } from 'gatho/sdk';
import type { NotifyMessage } from 'gatho/room';
import type { RunnerSpawnContext, Server } from 'gatho/server';
import { runner, start } from 'gatho/server';
import { afterEach, describe, expect, it } from 'vitest';

// a fake runner whose behaviour is supplied per test. it captures the spawn
// context (so a test can inject notify messages) and counts destructor calls.
type Harness = {
    roomId: string | null;
    ctx: RunnerSpawnContext | null;
    destructorCalls: number;
    timers: ReturnType<typeof setInterval>[];
};

function heartbeat(): NotifyMessage {
    return { type: 'heartbeat', timestamp: Date.now(), metrics: undefined, clients: [] };
}

// build a runner + harness. `behaviour` runs inside spawn and may set up timers
// (tracked for cleanup). the destructor clears timers and bumps the counter.
function makeRunner(behaviour: (ctx: RunnerSpawnContext, h: Harness) => void) {
    const h: Harness = { roomId: null, ctx: null, destructorCalls: 0, timers: [] };
    const r = runner((ctx) => {
        h.roomId = ctx.roomId;
        h.ctx = ctx;
        behaviour(ctx, h);
        return () => {
            h.destructorCalls++;
            for (const t of h.timers) clearInterval(t);
            h.timers.length = 0;
            // report the exit asynchronously, mirroring a real subprocess whose
            // exit lands a tick after kill() — this lets the server's own
            // teardown (e.g. the stall sweep's roomFailure) run first, and it
            // resolves the room's `exited` promise so server.stop() can drain.
            setTimeout(() => ctx.stopped(0), 0);
        };
    });
    return { runner: r, h };
}

async function waitUntil(pred: () => boolean | Promise<boolean>, deadlineMs = 3000, stepMs = 25): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
        if (await pred()) return true;
        await new Promise((r) => setTimeout(r, stepMs));
    }
    return await pred();
}

// tiny timeouts so the whole file stays fast.
const HEARTBEAT_INTERVAL_MS = 100;
const STALL_TIMEOUT_MS = 400;
const STARTUP_TIMEOUT_MS = 1500;

describe('room startup + stall timing', () => {
    let driver: Driver;
    let sdk: GathoSDK;
    let server: Server | null = null;

    afterEach(async () => {
        if (server) {
            await server.stop();
            server = null;
        }
        driver?.destroy?.();
    });

    async function startServer(runners: Record<string, ReturnType<typeof runner>>): Promise<Server> {
        driver = createMemoryDriver();
        sdk = createGathoSDK({ driver });
        const s = await start({
            rooms: runners,
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            roomStallTimeoutMs: STALL_TIMEOUT_MS,
            roomStartupTimeoutMs: STARTUP_TIMEOUT_MS,
            drainTimeoutMs: 2000,
        });
        server = s;
        return s;
    }

    // (a) REGRESSION — the stall sweep must not race startup. a room that stays
    // silent past the stall timeout but within the startup timeout, then starts
    // heartbeating, must reach 'ready' and NOT be killed. this fails on pre-fix
    // code that seeded the heartbeat clock at spawn (the sweep would kill it
    // ~STALL_TIMEOUT_MS into the silent window, before it ever spoke).
    it('does not kill a room that is silent past the stall timeout but starts up before the startup timeout', async () => {
        // silent for 800ms: > STALL_TIMEOUT_MS (400), < STARTUP_TIMEOUT_MS (1500)
        const { runner: r, h } = makeRunner((ctx, harness) => {
            setTimeout(() => {
                ctx.onMessage({ type: 'ready', port: 1 });
                harness.timers.push(setInterval(() => ctx.onMessage(heartbeat()), HEARTBEAT_INTERVAL_MS));
            }, 800);
        });
        await startServer({ game: r });

        const room = await sdk.createRoom({ type: 'game', serverId: server!.serverId, data: {}, tags: {}, timeoutMs: 4000 });
        expect(room.status).toBe('running');

        // room reached 'ready' and is still there
        expect(await waitUntil(() => server!.getRoomDetails(room.roomId)?.status === 'ready')).toBe(true);

        // let more than a stall window pass with heartbeats flowing — must survive
        await new Promise((res) => setTimeout(res, STALL_TIMEOUT_MS + 200));
        const details = server!.getRoomDetails(room.roomId);
        expect(details).not.toBeNull();
        expect(details!.status).toBe('ready');
        expect(h.destructorCalls).toBe(0);
    });

    // (b) startup timeout — a room that never speaks fails startup and the runner
    // destructor is called.
    it('fails a room that never sends a notify message and tears the runner down', async () => {
        const { runner: r, h } = makeRunner(() => {
            // never sends anything
        });
        await startServer({ game: r });

        // sdk timeout > startup timeout so the server's startup timeout is the
        // mechanism that fails the room.
        await expect(
            sdk.createRoom({ type: 'game', serverId: server!.serverId, data: {}, tags: {}, timeoutMs: STARTUP_TIMEOUT_MS + 400 }),
        ).rejects.toBeTruthy();

        expect(h.roomId).not.toBeNull();
        // memory driver semantics: roomFailure deletes the room → getRoom is null
        expect(await sdk.getRoom(h.roomId!)).toBeNull();
        expect(h.destructorCalls).toBeGreaterThan(0);
    });

    // (c) exit before first message — a room that exits during startup fails fast,
    // well before the startup timeout.
    it('fails fast when the room exits before its first message', async () => {
        const { runner: r, h } = makeRunner((ctx) => {
            setTimeout(() => ctx.stopped(1), 50);
        });
        await startServer({ game: r });

        const t0 = Date.now();
        // don't await the rejection for timing — observe the driver directly.
        const createPromise = sdk
            .createRoom({ type: 'game', serverId: server!.serverId, data: {}, tags: {}, timeoutMs: STARTUP_TIMEOUT_MS - 200 })
            .then(
                () => 'resolved',
                () => 'rejected',
            );

        expect(await waitUntil(() => h.roomId !== null)).toBe(true);
        // room disappears well before the startup timeout would have fired
        expect(await waitUntil(async () => (await sdk.getRoom(h.roomId!)) === null, STARTUP_TIMEOUT_MS - 300)).toBe(true);
        expect(Date.now() - t0).toBeLessThan(STARTUP_TIMEOUT_MS);
        expect(h.destructorCalls).toBeGreaterThan(0);

        expect(await createPromise).toBe('rejected');
    });

    // (d) stall after ready — a room that goes ready, heartbeats a few times, then
    // goes silent is killed after the stall timeout.
    it('kills a started room that stops heartbeating', async () => {
        const { runner: r, h } = makeRunner((ctx, harness) => {
            ctx.onMessage({ type: 'ready', port: 1 });
            let sent = 0;
            const t = setInterval(() => {
                ctx.onMessage(heartbeat());
                if (++sent >= 3) {
                    clearInterval(t);
                    harness.timers = harness.timers.filter((x) => x !== t);
                }
            }, HEARTBEAT_INTERVAL_MS);
            harness.timers.push(t);
        });
        await startServer({ game: r });

        const room = await sdk.createRoom({ type: 'game', serverId: server!.serverId, data: {}, tags: {}, timeoutMs: 2000 });
        expect(room.status).toBe('running');

        // after the heartbeats stop, the stall sweep kills the room (memory driver
        // deletes it on roomFailure) and the runner is torn down.
        expect(await waitUntil(async () => (await sdk.getRoom(room.roomId)) === null, 2000)).toBe(true);
        expect(server!.getRoomDetails(room.roomId)).toBeNull();
        expect(h.destructorCalls).toBeGreaterThan(0);
    });

    // (e) status / getRoomDetails progression: starting → ready.
    it('reports starting (no heartbeat) then ready (recent heartbeat) via getRoomDetails', async () => {
        // silent runner — the test drives messages via the captured ctx.
        const { runner: r, h } = makeRunner(() => {});
        await startServer({ game: r });

        const createPromise = sdk.createRoom({
            type: 'game',
            serverId: server!.serverId,
            data: {},
            tags: {},
            timeoutMs: 3000,
        });

        // wait for the room to be registered/spawned, then inspect it while silent
        expect(await waitUntil(() => h.roomId !== null && server!.getRoomDetails(h.roomId!) !== null)).toBe(true);
        const roomId = h.roomId!;
        const starting = server!.getRoomDetails(roomId)!;
        expect(starting.status).toBe('starting');
        expect(starting.lastHeartbeatAt).toBeNull();
        expect(h.ctx!.status()).toBe('starting');

        // now drive ready + a heartbeat
        const beforeReady = Date.now();
        h.ctx!.onMessage({ type: 'ready', port: 1 });
        h.ctx!.onMessage(heartbeat());

        const room = await createPromise;
        expect(room.status).toBe('running');

        const ready = server!.getRoomDetails(roomId)!;
        expect(ready.status).toBe('ready');
        expect(ready.lastHeartbeatAt).not.toBeNull();
        expect(ready.lastHeartbeatAt!).toBeGreaterThanOrEqual(beforeReady);
        expect(h.ctx!.status()).toBe('ready');
    });
});
