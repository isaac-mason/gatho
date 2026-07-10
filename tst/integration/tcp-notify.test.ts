// e2e-style test of the tcp notify channel with a REAL subprocess room.
//
// placement note: this lives in tst/integration (run via `pnpm run
// test:integration`, no docker) rather than tst/e2e, because the e2e harness
// (tst/e2e.sh) brings up docker-compose services for the whole suite. The room
// is spawned with `node` on a .ts fixture (node strips the types), resolving
// `gatho/room` to the built dist — same as the bun-spawned e2e rooms.
//
// the runner here swaps the default uds channel for a tcp one: it stands up a
// `notify.tcp` listener and hands the room only `chan.env` (the tcp uri with the
// bearer token) — no uds socket. everything downstream (room becomes running, a
// client can join + echo, ctx.status() flips to 'ready') must work unchanged.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { connect } from 'gatho/client';
import { createMemoryDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';
import type { RunnerSpawnContext, Server } from 'gatho/server';
import { notify, runner, start } from 'gatho/server';
import { afterEach, describe, expect, it } from 'vitest';

const ECHO_ROOM = resolve(import.meta.dirname, 'fixtures', 'echo-room.ts');

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(pred: () => boolean, deadlineMs = 8000, stepMs = 50): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
        if (pred()) return true;
        await sleep(stepMs);
    }
    return pred();
}

describe('tcp notify channel (real subprocess room)', () => {
    let server: Server | null = null;

    afterEach(async () => {
        if (server) {
            await server.stop();
            server = null;
        }
    });

    it('spawns a room over tcp, echoes a client message, and reports ready', { timeout: 20_000 }, async () => {
        const driver = createMemoryDriver();
        const sdk = createGathoSDK({ driver });

        // capture the spawn context so the test can inspect ctx.status()
        let capturedCtx: RunnerSpawnContext | null = null;

        const tcpEcho = runner(async (ctx) => {
            capturedCtx = ctx;
            const chan = await notify.tcp(ctx);

            const child = spawn('node', [ECHO_ROOM], {
                // NB: ...chan.env carries GATHO_NOTIFY_SOCKET as a tcp uri; no uds.
                env: { ...process.env, ...ctx.env, ...chan.env } as NodeJS.ProcessEnv,
                stdio: ['ignore', 'inherit', 'inherit'],
            });

            let reported = false;
            const report = (code: number | null): void => {
                if (reported) return;
                reported = true;
                chan.close();
                ctx.stopped(code);
            };
            child.on('exit', (code) => report(code));
            child.on('error', (err) => {
                ctx.onMessage({ type: 'error', message: `spawn failed: ${err.message}` });
                report(-1);
            });

            let killed = false;
            return () => {
                if (killed) return;
                killed = true;
                child.kill('SIGTERM');
                const t = setTimeout(() => child.kill('SIGKILL'), 3000);
                t.unref();
            };
        });

        server = await start({
            rooms: { echo: tcpEcho },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
            heartbeatIntervalMs: 500,
        });

        // room becomes running (the room dialed back over tcp and sent `ready`)
        const room = await sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
            timeoutMs: 15_000,
        });
        expect(room.status).toBe('running');
        expect(room.endpoint).toMatch(/^ws:\/\//);

        // the runner captured a context and the server observed the room as ready
        expect(capturedCtx).not.toBeNull();
        expect(capturedCtx!.status()).toBe('ready');
        expect(server.getRoomDetails(room.roomId)?.status).toBe('ready');

        // a client can join and round-trip a message through the echo room
        const reservation = await sdk.join({ roomId: room.roomId, ttl: 30_000 });
        const messages: unknown[] = [];
        const conn = connect(reservation.url, {
            onMessage: (msg) => messages.push(msg),
        });

        expect(await waitUntil(() => conn.state === 'open')).toBe(true);

        conn.send(JSON.stringify({ hello: 'tcp' }));
        expect(await waitUntil(() => messages.length >= 1)).toBe(true);
        expect(messages[0]).toBe(JSON.stringify({ hello: 'tcp' }));

        conn.close();

        // teardown is clean — server.stop() (in afterEach) terminates the room
        await server.stop();
        server = null;
        // room process is gone; ctx reported stopped
        expect(await waitUntil(() => capturedCtx!.status() === 'stopped')).toBe(true);
    });
});
