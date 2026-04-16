// e2e test helpers
import { resolve } from 'path';
import type { RoomConnection } from '../../client';
import { connect } from '../../client';
import type { Driver } from '../../driver/types';
import type { GathoSDK } from '../../sdk';
import { createGathoSDK } from '../../sdk';
import { createServer, subprocess } from '../../server';
import type { Server } from '../../server/server';

const ROOMS_DIR = resolve(import.meta.dirname, 'rooms');

export const roomScripts = {
    echo: resolve(ROOMS_DIR, 'echo.ts'),
    joinData: resolve(ROOMS_DIR, 'join-data.ts'),
};

export type TestContext = {
    driver: Driver;
    sdk: GathoSDK;
    // start a server with sensible defaults, tracked for cleanup
    startServer: (opts?: { tags?: Record<string, string> }) => Promise<Server>;
    // clean up all servers started during this test
    cleanup: () => Promise<void>;
};

export function buildContext(driver: Driver): TestContext {
    const sdk = createGathoSDK({ driver });
    const servers: Server[] = [];

    async function startServer(opts?: { tags?: Record<string, string> }): Promise<Server> {
        const server = createServer({
            rooms: {
                echo: subprocess(['bun', 'run', roomScripts.echo]),
                'join-data': subprocess(['bun', 'run', roomScripts.joinData]),
            },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
            tags: opts?.tags ?? {},
        });

        await server.start();
        servers.push(server);
        return server;
    }

    async function cleanup() {
        await Promise.all(servers.map((s) => s.stop()));
        servers.length = 0;
    }

    return { driver, sdk, startServer, cleanup };
}

// wait for a condition to be true, polling at interval
export async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 5_000, intervalMs = 100): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await fn()) return;
        await sleep(intervalMs);
    }
    throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// connect to a room and collect messages into an array.
// returns the connection and a helper to wait for N messages.
export function connectAndCollect(url: string): {
    conn: RoomConnection;
    messages: unknown[];
    waitForMessages: (n: number, timeoutMs?: number) => Promise<unknown[]>;
    authError: Promise<unknown>;
} {
    const conn = connect(url);
    const messages: unknown[] = [];
    let authResolve: (err: unknown) => void;

    const authError = new Promise<unknown>((resolve) => {
        authResolve = resolve;
    });

    // prevent unhandled rejection — if nothing awaits authError, that's fine
    authError.catch(() => {});

    conn.on('message', (msg) => messages.push(msg));
    conn.on('authError', (err) => authResolve(err));

    async function waitForMessages(n: number, timeoutMs = 5_000): Promise<unknown[]> {
        const start = Date.now();
        while (messages.length < n) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(`expected ${n} messages but got ${messages.length} after ${timeoutMs}ms`);
            }
            await sleep(50);
        }
        return messages.slice(0, n);
    }

    return { conn, messages, waitForMessages, authError };
}
