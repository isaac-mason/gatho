import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/driver/memory';
import { __heartbeatTickForTest } from '../../src/server/server';

const serverId = 'server-1';
const endpoint = 'http://10.0.0.5:3000';

async function seedRunningRoomWithNoProcess(driver: ReturnType<typeof createMemoryDriver>, roomId: string) {
    await driver._internal.heartbeat({ serverId, endpoint, tags: {}, roomTypes: ['game'] });
    await driver._internal.registerRoom(roomId, 'game', serverId, {}, {}, 60_000);
    await driver._internal.roomReady(roomId, 'ws://10.0.0.5:9000', 'secret-1');
}

describe('reconcile of running rooms missing locally', () => {
    it('does not report a missing running room on its first observation', async () => {
        const driver = createMemoryDriver();
        await seedRunningRoomWithNoProcess(driver, 'room-1');

        await __heartbeatTickForTest({
            driver: driver._internal,
            serverId,
            endpoint,
            rooms: [],
            previouslyRegistered: true,
            roomStallTimeoutMs: 0,
        });

        expect((await driver._internal.getRoomInfo('room-1'))?.status).toBe('running');
        driver.destroy?.();
    });

    it('reports it failed once it stays missing past the stall grace', async () => {
        const driver = createMemoryDriver();
        await seedRunningRoomWithNoProcess(driver, 'room-1');

        await __heartbeatTickForTest({
            driver: driver._internal,
            serverId,
            endpoint,
            rooms: [],
            previouslyRegistered: true,
            ticks: 2,
            roomStallTimeoutMs: 0,
        });

        expect(await driver._internal.getRoomInfo('room-1')).toBeNull();
        driver.destroy?.();
    });

    it('keeps a missing running room while the grace has not elapsed', async () => {
        const driver = createMemoryDriver();
        await seedRunningRoomWithNoProcess(driver, 'room-1');

        await __heartbeatTickForTest({
            driver: driver._internal,
            serverId,
            endpoint,
            rooms: [],
            previouslyRegistered: true,
            ticks: 3,
            roomStallTimeoutMs: 60_000,
        });

        expect((await driver._internal.getRoomInfo('room-1'))?.status).toBe('running');
        driver.destroy?.();
    });

    it('leaves a running room that has a local process alone', async () => {
        const driver = createMemoryDriver();
        await seedRunningRoomWithNoProcess(driver, 'room-1');

        const { killed } = await __heartbeatTickForTest({
            driver: driver._internal,
            serverId,
            endpoint,
            rooms: [
                {
                    roomId: 'room-1',
                    roomType: 'game',
                    roomSecret: 'secret-1',
                    data: {},
                    endpoint: 'ws://10.0.0.5:9000',
                    status: 'ready',
                },
            ],
            previouslyRegistered: true,
            ticks: 3,
            roomStallTimeoutMs: 0,
        });

        expect(killed).toEqual([]);
        expect((await driver._internal.getRoomInfo('room-1'))?.status).toBe('running');
        driver.destroy?.();
    });
});
