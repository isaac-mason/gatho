// R11b: reap recovery — re-assert live rooms after the server record is reaped.
//
// a driver blip can stall a server's heartbeats past the staleness threshold; the
// leader then reaps the server, which also deletes the server's room records. when
// connectivity returns the next heartbeat re-creates the server record (registered:
// true) but comes back with an EMPTY desired-set. without intervention the destroy
// sweep would kill every healthy, client-occupied room. reap-recovery re-asserts
// still-running local rooms into the driver BEFORE the sweep runs.
//
// the critical ordering is that the re-assert happens first: the same heartbeat
// result that reports registered:true carries the (empty) desiredRooms, and the
// destroy sweep in that same tick must NOT kill the rooms we re-assert.

import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/driver/memory';
import { __heartbeatTickForTest, type TestRoom } from '../../src/server/server';

async function seedRunningRoom(driver: ReturnType<typeof createMemoryDriver>, serverId: string, roomId: string) {
    await driver._internal.heartbeat({ serverId, endpoint: 'http://10.0.0.5:3000', tags: {}, roomTypes: ['game'] });
    await driver._internal.registerRoom(roomId, 'game', serverId, { level: 3 }, {});
    await driver._internal.roomReady(roomId, 'ws://10.0.0.5:9000', 'secret-1');
}

describe('reap recovery', () => {
    it('re-registers a ready local room after its server record was reaped, without destroying it', async () => {
        const driver = createMemoryDriver();
        const serverId = 'server-1';
        const roomId = 'room-1';

        await seedRunningRoom(driver, serverId, roomId);

        // simulate the reap: unregisterServer deletes the server AND its rooms.
        await driver._internal.unregisterServer(serverId);
        expect(await driver._internal.getRoomInfo(roomId)).toBeNull();

        // the room is still running locally (ready + endpoint present).
        const rooms: TestRoom[] = [
            {
                roomId,
                roomType: 'game',
                roomSecret: 'secret-1',
                data: { level: 3 },
                endpoint: 'ws://10.0.0.5:9000',
                status: 'ready',
            },
        ];

        const { killed } = await __heartbeatTickForTest({
            driver: driver._internal,
            serverId,
            endpoint: 'http://10.0.0.5:3000',
            rooms,
            previouslyRegistered: true,
        });

        // the room must NOT have been destroyed by the same tick's sweep.
        expect(killed).toEqual([]);

        // and the driver record must be restored: running, with data preserved.
        const info = await driver._internal.getRoomInfo(roomId);
        expect(info).not.toBeNull();
        expect(info!.status).toBe('running');
        expect(info!.serverId).toBe(serverId);
        expect(info!.endpoint).toBe('ws://10.0.0.5:9000');
        expect(info!.data).toEqual({ level: 3 });

        driver.destroy?.();
    });

    it('does not re-assert rooms that are still in the driver desired set (record survived)', async () => {
        // if the heartbeat is a normal reap-recovery but the room record survived
        // (it is in desiredRooms), we must not touch it — and we must not destroy it.
        const driver = createMemoryDriver();
        const serverId = 'server-2';
        const roomId = 'room-2';

        await seedRunningRoom(driver, serverId, roomId);

        // do NOT reap — the room is present in the driver, so heartbeat returns it
        // in desiredRooms. registered will be false here (record exists), so this
        // is just the steady-state path: room survives, nothing killed.
        const rooms: TestRoom[] = [
            {
                roomId,
                roomType: 'game',
                roomSecret: 'secret-1',
                data: { level: 3 },
                endpoint: 'ws://10.0.0.5:9000',
                status: 'ready',
            },
        ];

        const { killed } = await __heartbeatTickForTest({
            driver: driver._internal,
            serverId,
            endpoint: 'http://10.0.0.5:3000',
            rooms,
            previouslyRegistered: true,
        });

        expect(killed).toEqual([]);
        const info = await driver._internal.getRoomInfo(roomId);
        expect(info!.status).toBe('running');

        driver.destroy?.();
    });

    it('destroys a local room the driver no longer wants (no reap-recovery in play)', async () => {
        // steady state: our record is fine, but a room was deliberately destroyed
        // via the sdk so it is absent from desiredRooms. the sweep must kill it.
        const driver = createMemoryDriver();
        const serverId = 'server-3';
        const roomId = 'room-3';

        await driver._internal.heartbeat({ serverId, endpoint: 'http://10.0.0.5:3000', tags: {}, roomTypes: ['game'] });
        // note: the room is NOT registered in the driver — it exists only locally,
        // mirroring "sdk destroyed it, our local process hasn't been swept yet".

        const rooms: TestRoom[] = [
            {
                roomId,
                roomType: 'game',
                roomSecret: 'secret-1',
                data: {},
                endpoint: 'ws://10.0.0.5:9000',
                status: 'ready',
            },
        ];

        const { killed } = await __heartbeatTickForTest({
            driver: driver._internal,
            serverId,
            endpoint: 'http://10.0.0.5:3000',
            rooms,
            // previouslyRegistered but the heartbeat here does NOT return registered:true
            // (the server record already exists), so reap-recovery does not fire and
            // the sweep destroys the unwanted room.
            previouslyRegistered: true,
        });

        expect(killed).toEqual([roomId]);

        driver.destroy?.();
    });
});
