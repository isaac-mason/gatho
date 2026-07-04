// reconciliation test — verifies heartbeat-driven client reconciliation
// when fast-path connect/disconnect messages fail, the heartbeat backstop
// should eventually correct driver state.

import { createMemoryDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';
import type { Server } from 'gatho/server';
import { start, subprocess } from 'gatho/server';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAndCollect, roomScripts, sleep, waitUntil } from './helpers';

describe('client reconciliation via heartbeat', () => {
    let server: Server | null = null;

    afterEach(async () => {
        if (server) {
            await server.stop();
            server = null;
        }
    });

    it('recovers when connectClient fast-path fails', async () => {
        const driver = createMemoryDriver();
        const sdk = createGathoSDK({ driver });

        // intercept connectClient — fail the first call, then let subsequent calls through.
        // this simulates a transient driver error on the fast-path ipc handler.
        let blockConnect = true;
        const originalConnect = driver._internal.connectClient.bind(driver._internal);
        driver._internal.connectClient = async (clientId: string, roomId: string, tags: Record<string, string>) => {
            if (blockConnect) {
                blockConnect = false;
                throw new Error('simulated transient failure');
            }
            return originalConnect(clientId, roomId, tags);
        };

        server = await start({
            rooms: {
                echo: subprocess(['bun', 'run', roomScripts.echo]),
            },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
        });

        // create room and join
        const room = await sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        const reservation = await sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
        });

        // connect — the fast-path connectClient will fail
        const { conn, waitForMessages } = connectAndCollect(reservation.url);
        await sleep(200);

        // verify the message round-trip works (ws is fine, only driver state drifted)
        conn.send(JSON.stringify({ hello: 'world' }));
        const msgs = await waitForMessages(1);
        expect(msgs[0]).toBe(JSON.stringify({ hello: 'world' }));

        // the client should still be 'reserved' in the driver because connectClient failed
        const roomInfoBefore = await driver._internal.getRoomInfo(room.roomId);
        expect(roomInfoBefore).not.toBeNull();
        const clientBefore = roomInfoBefore!.clients.find((c) => c.clientId === reservation.clientId);
        expect(clientBefore).toBeDefined();
        expect(clientBefore!.status).toBe('reserved');

        // wait for heartbeat reconciliation to fix it (heartbeat every 3s)
        await waitUntil(async () => {
            const info = await driver._internal.getRoomInfo(room.roomId);
            if (!info) return false;
            const client = info.clients.find((c) => c.clientId === reservation.clientId);
            return client?.status === 'connected';
        }, 10_000);

        // verify the client is now 'connected' in the driver
        const roomInfoAfter = await driver._internal.getRoomInfo(room.roomId);
        const clientAfter = roomInfoAfter!.clients.find((c) => c.clientId === reservation.clientId);
        expect(clientAfter).toBeDefined();
        expect(clientAfter!.status).toBe('connected');

        conn.close();
    }, 15_000);

    it('cleans up stale connected client when disconnectClient fast-path fails', async () => {
        const driver = createMemoryDriver();
        const sdk = createGathoSDK({ driver });

        server = await start({
            rooms: {
                echo: subprocess(['bun', 'run', roomScripts.echo]),
            },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
        });

        // create room and join
        const room = await sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        const reservation = await sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
        });

        // connect normally — let the fast-path connectClient succeed
        const { conn, waitForMessages } = connectAndCollect(reservation.url);
        await sleep(200);

        // verify connected
        conn.send(JSON.stringify({ ping: true }));
        const msgs = await waitForMessages(1);
        expect(msgs[0]).toBe(JSON.stringify({ ping: true }));

        // verify client is 'connected' in driver
        await waitUntil(async () => {
            const info = await driver._internal.getRoomInfo(room.roomId);
            if (!info) return false;
            const client = info.clients.find((c) => c.clientId === reservation.clientId);
            return client?.status === 'connected';
        }, 5_000);

        // now intercept disconnectClient to fail once — simulating a lost fast-path message
        let blockDisconnect = true;
        const originalDisconnect = driver._internal.disconnectClient.bind(driver._internal);
        driver._internal.disconnectClient = async (clientId: string) => {
            if (blockDisconnect) {
                blockDisconnect = false;
                throw new Error('simulated transient failure');
            }
            return originalDisconnect(clientId);
        };

        // disconnect the client — the fast-path disconnectClient will fail
        conn.close();
        await sleep(500);

        // the client should still be 'connected' in the driver because disconnectClient failed
        const roomInfoBefore = await driver._internal.getRoomInfo(room.roomId);
        expect(roomInfoBefore).not.toBeNull();
        const clientBefore = roomInfoBefore!.clients.find((c) => c.clientId === reservation.clientId);
        expect(clientBefore).toBeDefined();
        expect(clientBefore!.status).toBe('connected');

        // wait for heartbeat reconciliation to clean it up (heartbeat every 3s)
        await waitUntil(async () => {
            const info = await driver._internal.getRoomInfo(room.roomId);
            if (!info) return false;
            // disconnectClient in memory driver deletes the client entirely
            const client = info.clients.find((c) => c.clientId === reservation.clientId);
            return client === undefined;
        }, 10_000);

        // verify the stale client is gone
        const roomInfoAfter = await driver._internal.getRoomInfo(room.roomId);
        const clientAfter = roomInfoAfter!.clients.find((c) => c.clientId === reservation.clientId);
        expect(clientAfter).toBeUndefined();
    }, 15_000);

    it('does not produce spurious actions when driver state is correct', async () => {
        const driver = createMemoryDriver();
        const sdk = createGathoSDK({ driver });

        // track all connectClient/disconnectClient calls after initial setup
        const connectCalls: string[] = [];
        const disconnectCalls: string[] = [];
        let tracking = false;

        const originalConnect = driver._internal.connectClient.bind(driver._internal);
        const originalDisconnect = driver._internal.disconnectClient.bind(driver._internal);

        driver._internal.connectClient = async (clientId: string, roomId: string, tags: Record<string, string>) => {
            if (tracking) connectCalls.push(clientId);
            return originalConnect(clientId, roomId, tags);
        };
        driver._internal.disconnectClient = async (clientId: string) => {
            if (tracking) disconnectCalls.push(clientId);
            return originalDisconnect(clientId);
        };

        server = await start({
            rooms: {
                echo: subprocess(['bun', 'run', roomScripts.echo]),
            },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
        });

        // create room and join
        const room = await sdk.createRoom({
            type: 'echo',
            serverId: server.serverId,
            data: {},
            tags: {},
        });

        const reservation = await sdk.join({
            roomId: room.roomId,
            ttl: 30_000,
        });

        // connect
        const { conn, waitForMessages } = connectAndCollect(reservation.url);
        await sleep(200);

        // verify connected
        conn.send(JSON.stringify({ test: true }));
        await waitForMessages(1);

        // wait for the client to be 'connected' in the driver
        await waitUntil(async () => {
            const info = await driver._internal.getRoomInfo(room.roomId);
            if (!info) return false;
            const client = info.clients.find((c) => c.clientId === reservation.clientId);
            return client?.status === 'connected';
        }, 5_000);

        // now start tracking — driver state is consistent, so reconciliation
        // should produce zero connect/disconnect calls
        tracking = true;

        // wait through 2 heartbeat cycles (~6s) to be sure
        await sleep(7_000);

        // no spurious reconciliation actions should have occurred
        expect(connectCalls).toEqual([]);
        expect(disconnectCalls).toEqual([]);

        conn.close();
    }, 15_000);
});
