// tests that memoryDriver prunes stale servers, their rooms/clients,
// and expired client reservations on the background interval
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDriver } from '../../src/driver';
import type { Driver } from '../../src/driver/types';

const STALE_MS = 30_000;
const PRUNE_INTERVAL_MS = 10_000;

describe('memoryDriver prune', () => {
    let driver: Driver;

    beforeEach(() => {
        vi.useFakeTimers();
        driver = createMemoryDriver();
    });

    afterEach(() => {
        driver.destroy?.();
        vi.useRealTimers();
    });

    it('prunes stale servers and their rooms after STALE_MS', async () => {
        // register a server
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });

        // register a room on that server
        await driver._internal.registerRoom('r1', 'game', 's1', {}, {});

        // server is alive — should be visible
        const before = await driver._internal.listServers();
        expect(before).toHaveLength(1);
        const roomsBefore = await driver._internal.listRooms();
        expect(roomsBefore).toHaveLength(1);

        // advance past stale threshold + prune interval
        vi.advanceTimersByTime(STALE_MS + PRUNE_INTERVAL_MS);

        // server and its room should be pruned
        const after = await driver._internal.listServers();
        expect(after).toHaveLength(0);
        const roomsAfter = await driver._internal.listRooms();
        expect(roomsAfter).toHaveLength(0);
    });

    it('does not prune servers that heartbeat regularly', async () => {
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });

        // heartbeat halfway through the stale window, then advance past stale
        vi.advanceTimersByTime(STALE_MS / 2);
        await driver._internal.heartbeat('s1');
        vi.advanceTimersByTime(STALE_MS / 2 + PRUNE_INTERVAL_MS);

        // server renewed — should still be alive
        const servers = await driver._internal.listServers();
        expect(servers).toHaveLength(1);
    });

    it('prunes expired client reservations', async () => {
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });
        await driver._internal.registerRoom('r1', 'game', 's1', {}, {});
        await driver._internal.roomReady('r1', 'ws://localhost:9001', 'secret123');

        // reserve a client with a 5s ttl
        const ttl = 5_000;
        const reservation = await driver._internal.reserveClient('r1', ttl);
        expect(reservation.clientId).toBeTruthy();

        // room should have 1 client
        const infoBefore = await driver._internal.getRoomInfo('r1');
        expect(infoBefore?.clients).toHaveLength(1);
        expect(infoBefore?.clients[0].status).toBe('reserved');

        // advance past ttl + prune interval (but keep server alive)
        vi.advanceTimersByTime(ttl + PRUNE_INTERVAL_MS);
        // heartbeat to keep the server alive
        await driver._internal.heartbeat('s1');

        // the expired reservation should be pruned
        const infoAfter = await driver._internal.getRoomInfo('r1');
        expect(infoAfter?.clients).toHaveLength(0);
    });

    it('does not prune connected clients', async () => {
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });
        await driver._internal.registerRoom('r1', 'game', 's1', {}, {});
        await driver._internal.roomReady('r1', 'ws://localhost:9001', 'secret123');

        const reservation = await driver._internal.reserveClient('r1', 5_000);
        // client connects before expiry
        await driver._internal.connectClient(reservation.clientId);

        // advance in steps, heartbeating to keep the server alive
        for (let i = 0; i < 6; i++) {
            vi.advanceTimersByTime(PRUNE_INTERVAL_MS);
            await driver._internal.heartbeat('s1');
        }

        // connected client should still be there
        const info = await driver._internal.getRoomInfo('r1');
        expect(info?.clients).toHaveLength(1);
        expect(info?.clients[0].status).toBe('connected');
    });

    it('prunes clients belonging to stale servers rooms', async () => {
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });
        await driver._internal.registerRoom('r1', 'game', 's1', {}, {});
        await driver._internal.roomReady('r1', 'ws://localhost:9001', 'secret123');

        const reservation = await driver._internal.reserveClient('r1', 60_000);
        await driver._internal.connectClient(reservation.clientId);

        // let server go stale
        vi.advanceTimersByTime(STALE_MS + PRUNE_INTERVAL_MS);

        // everything should be gone
        const servers = await driver._internal.listServers();
        expect(servers).toHaveLength(0);
        const rooms = await driver._internal.listRooms();
        expect(rooms).toHaveLength(0);
        // room is gone so getRoomInfo returns null — clients are gone with it
        const info = await driver._internal.getRoomInfo('r1');
        expect(info).toBeNull();
    });

    it('destroy() stops the prune interval', async () => {
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });

        driver.destroy?.();

        // advance well past stale + prune — but destroy was called
        vi.advanceTimersByTime(STALE_MS + PRUNE_INTERVAL_MS * 10);

        // server should still be present (stale, but not pruned)
        // note: listServers filters by heartbeat so use getServer instead
        const server = await driver._internal.getServer('s1');
        expect(server).not.toBeNull();
    });
});
