// reconcileClients unit tests — regression coverage for the heartbeat/connect race.
//
// the reconciler reads driver state and compares it against `roomClients`, the
// room's authoritative snapshot at heartbeat capture time. without a happens-
// before gate, a client that connected after capture (and therefore couldn't be
// in the snapshot) gets disconnected as "stale". the gate is `connectedAt <
// heartbeatTimestamp`. these tests exercise both sides of that gate.

import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/driver/memory';
import { reconcileClients } from '../../src/server/server';

async function setupRoom() {
    const driver = createMemoryDriver();
    const serverId = 'server-1';
    const roomId = 'room-1';

    await driver._internal.heartbeat({
        serverId,
        endpoint: 'http://localhost:3000',
        tags: {},
        roomTypes: ['game'],
    });
    await driver._internal.registerRoom(roomId, 'game', serverId, {}, {});
    await driver._internal.roomReady(roomId, 'ws://localhost:9000', 'secret');

    const reservation = await driver._internal.reserveClient(roomId, 30_000, {}, {});
    return { driver, roomId, clientId: reservation.clientId };
}

describe('reconcileClients', () => {
    it('skips disconnect for clients that connected after the heartbeat snapshot', async () => {
        // setup: heartbeat snapshot was captured BEFORE the client connected.
        // this models the production race: under load, the room admits a client
        // between snapshot capture and heartbeat arrival; the driver writes the
        // client as connected before the reconciler reads driver state. the
        // reconciler must NOT disconnect the live peer.
        const { driver, roomId, clientId } = await setupRoom();

        const heartbeatTimestamp = Date.now();
        // ensure connectedAt > heartbeatTimestamp by waiting one ms boundary
        await new Promise((r) => setTimeout(r, 5));
        await driver._internal.connectClient(clientId, roomId, {});

        // room snapshot is empty (snapshot captured before the connect).
        await reconcileClients(driver._internal, roomId, [], heartbeatTimestamp);

        const info = await driver._internal.getRoomInfo(roomId);
        const client = info?.clients.find((c) => c.clientId === clientId);
        expect(client).toBeDefined();
        expect(client!.status).toBe('connected');
    });

    it('disconnects clients that connected before the heartbeat snapshot and are absent from it', async () => {
        // inverse of the above: the heartbeat snapshot was captured AFTER the
        // client connected, so its absence from `roomClients` is genuine
        // evidence that the room no longer has it. the reconciler should
        // disconnect.
        const { driver, roomId, clientId } = await setupRoom();

        await driver._internal.connectClient(clientId, roomId, {});
        await new Promise((r) => setTimeout(r, 5));
        const heartbeatTimestamp = Date.now();

        await reconcileClients(driver._internal, roomId, [], heartbeatTimestamp);

        const info = await driver._internal.getRoomInfo(roomId);
        const client = info?.clients.find((c) => c.clientId === clientId);
        expect(client).toBeUndefined();
    });

    it('connects clients that the room reports but the driver is missing', async () => {
        // forward path: client is in the room snapshot but the driver still has
        // it as 'reserved' (fast-path connectClient never landed). the
        // reconciler should call connectClient regardless of timestamp ordering.
        const { driver, roomId, clientId } = await setupRoom();

        await reconcileClients(
            driver._internal,
            roomId,
            [{ clientId, tags: {} }],
            Date.now(),
        );

        const info = await driver._internal.getRoomInfo(roomId);
        const client = info?.clients.find((c) => c.clientId === clientId);
        expect(client).toBeDefined();
        expect(client!.status).toBe('connected');
    });

    it('is a no-op when driver and room snapshot agree', async () => {
        // steady-state: client is connected in the driver and present in the
        // room snapshot. no spurious actions should fire.
        const { driver, roomId, clientId } = await setupRoom();

        await driver._internal.connectClient(clientId, roomId, {});
        await new Promise((r) => setTimeout(r, 5));

        await reconcileClients(
            driver._internal,
            roomId,
            [{ clientId, tags: {} }],
            Date.now(),
        );

        const info = await driver._internal.getRoomInfo(roomId);
        const client = info?.clients.find((c) => c.clientId === clientId);
        expect(client).toBeDefined();
        expect(client!.status).toBe('connected');
    });
});
