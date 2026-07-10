// R7: room-failed signal rejects waitForRoom fast with the real reason.
//
// before this, roomFailure just deleted the room and waitForRoom only listened
// for room-ready — a spawn failure burned the full timeout before rejecting with
// a generic RoomTimeoutError. now roomFailure publishes the reason first, and
// waitForRoom subscribes to both ready and failed, rejecting immediately with a
// RoomFailedError that carries the reason.

import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/driver/memory';
import { RoomFailedError, RoomTimeoutError } from '../../src/driver/errors';

async function setupRequestedRoom() {
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
    return { driver, roomId };
}

describe('memory driver room-failed', () => {
    it('rejects waitForRoom with RoomFailedError carrying the reason', async () => {
        const { driver, roomId } = await setupRequestedRoom();

        // long timeout — the failure must reject well before it, proving the
        // rejection is driven by the failed signal not the timeout backstop.
        const wait = driver._internal.waitForRoom(roomId, 60_000);
        await driver._internal.roomFailure(roomId, 'bad image');

        await expect(wait).rejects.toBeInstanceOf(RoomFailedError);
        await wait.catch((err: RoomFailedError) => {
            expect(err.code).toBe('room-failed');
            expect(err.roomId).toBe(roomId);
            expect(err.reason).toBe('bad image');
        });
    });

    it('still rejects with RoomTimeoutError when neither ready nor failed fires', async () => {
        const { driver, roomId } = await setupRequestedRoom();
        await expect(driver._internal.waitForRoom(roomId, 20)).rejects.toBeInstanceOf(RoomTimeoutError);
    });

    it('resolves normally when the room becomes ready', async () => {
        const { driver, roomId } = await setupRequestedRoom();
        const wait = driver._internal.waitForRoom(roomId, 60_000);
        await driver._internal.roomReady(roomId, 'ws://localhost:9000', 'secret');
        const info = await wait;
        expect(info.status).toBe('running');
    });
});
