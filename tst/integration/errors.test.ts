// tests that driver methods throw typed GathoError subclasses
// with correct .code, instanceof behavior, and contextual fields
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    GathoError,
    InvalidTagError,
    RoomNotFoundError,
    RoomNotRunningError,
    RoomTimeoutError,
    ServerNotFoundError,
} from '../../src/common/errors';
import { createMemoryDriver } from '../../src/driver';
import type { Driver } from '../../src/driver/types';

describe('typed errors', () => {
    let driver: Driver;

    beforeEach(() => {
        driver = createMemoryDriver();
    });

    afterEach(() => {
        driver.destroy?.();
    });

    // -- ServerNotFoundError --

    it('registerRoom throws ServerNotFoundError for missing server', async () => {
        const err = await getError(() => driver._internal.registerRoom('r1', 'game', 'no-server', {}, {}));
        expect(err).toBeInstanceOf(GathoError);
        expect(err).toBeInstanceOf(ServerNotFoundError);
        expect(err.code).toBe('server-not-found');
        expect((err as ServerNotFoundError).serverId).toBe('no-server');
    });

    it('addServerTags throws ServerNotFoundError for missing server', async () => {
        const err = await getError(() => driver._internal.addServerTags('no-server', { region: 'us' }));
        expect(err).toBeInstanceOf(ServerNotFoundError);
        expect(err.code).toBe('server-not-found');
    });

    it('removeServerTags throws ServerNotFoundError for missing server', async () => {
        const err = await getError(() => driver._internal.removeServerTags('no-server', ['region']));
        expect(err).toBeInstanceOf(ServerNotFoundError);
        expect(err.code).toBe('server-not-found');
    });

    // -- RoomNotFoundError --

    it('addRoomTags throws RoomNotFoundError for missing room', async () => {
        const err = await getError(() => driver._internal.addRoomTags('no-room', { mode: 'ranked' }));
        expect(err).toBeInstanceOf(GathoError);
        expect(err).toBeInstanceOf(RoomNotFoundError);
        expect(err.code).toBe('room-not-found');
        expect((err as RoomNotFoundError).roomId).toBe('no-room');
    });

    it('removeRoomTags throws RoomNotFoundError for missing room', async () => {
        const err = await getError(() => driver._internal.removeRoomTags('no-room', ['mode']));
        expect(err).toBeInstanceOf(RoomNotFoundError);
        expect(err.code).toBe('room-not-found');
    });

    it('reserveClient throws RoomNotFoundError for missing room', async () => {
        const err = await getError(() => driver._internal.reserveClient('no-room', 10_000));
        expect(err).toBeInstanceOf(RoomNotFoundError);
        expect(err.code).toBe('room-not-found');
    });

    // -- RoomNotRunningError --

    it('reserveClient throws RoomNotRunningError for a room that is not running yet', async () => {
        await registerServerAndRoom(driver);
        // room is 'requested', not 'running'
        const err = await getError(() => driver._internal.reserveClient('r1', 10_000));
        expect(err).toBeInstanceOf(GathoError);
        expect(err).toBeInstanceOf(RoomNotRunningError);
        expect(err.code).toBe('room-not-running');
        expect((err as RoomNotRunningError).roomId).toBe('r1');
    });

    // -- RoomTimeoutError --

    it('waitForRoom throws RoomTimeoutError when room never becomes running', async () => {
        await registerServerAndRoom(driver);
        const err = await getError(() => driver._internal.waitForRoom('r1', 50));
        expect(err).toBeInstanceOf(GathoError);
        expect(err).toBeInstanceOf(RoomTimeoutError);
        expect(err.code).toBe('room-timeout');
        expect((err as RoomTimeoutError).roomId).toBe('r1');
        expect((err as RoomTimeoutError).timeoutMs).toBe(50);
    });

    // -- InvalidTagError --

    it('registerRoom throws InvalidTagError for bad tag key', async () => {
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });
        const err = await getError(() => driver._internal.registerRoom('r1', 'game', 's1', {}, { 'bad key!': 'val' }));
        expect(err).toBeInstanceOf(GathoError);
        expect(err).toBeInstanceOf(InvalidTagError);
        expect(err.code).toBe('invalid-tag');
    });

    it('registerRoom throws InvalidTagError for bad tag value', async () => {
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });
        const err = await getError(() => driver._internal.registerRoom('r1', 'game', 's1', {}, { key: 'bad value!' }));
        expect(err).toBeInstanceOf(InvalidTagError);
        expect(err.code).toBe('invalid-tag');
    });

    it('registerRoom throws InvalidTagError for reserved tag key (starts with _)', async () => {
        await driver._internal.registerServer({
            serverId: 's1',
            endpoint: 'http://localhost:3000',
            tags: {},
            roomTypes: ['game'],
        });
        const err = await getError(() => driver._internal.registerRoom('r1', 'game', 's1', {}, { _internal: 'secret' }));
        expect(err).toBeInstanceOf(InvalidTagError);
        expect(err.code).toBe('invalid-tag');
        expect(err.message).toContain('reserved');
    });

    // -- all GathoError subclasses have .name set to constructor name --

    it('error .name matches constructor name', () => {
        expect(new ServerNotFoundError('s1').name).toBe('ServerNotFoundError');
        expect(new RoomNotFoundError('r1').name).toBe('RoomNotFoundError');
        expect(new RoomNotRunningError('r1').name).toBe('RoomNotRunningError');
        expect(new RoomTimeoutError('r1', 5000).name).toBe('RoomTimeoutError');
        expect(new InvalidTagError('detail').name).toBe('InvalidTagError');
    });

    // -- catch-all GathoError instanceof works --

    it('all domain errors are instanceof GathoError', () => {
        const errors: GathoError[] = [
            new ServerNotFoundError('s1'),
            new RoomNotFoundError('r1'),
            new RoomNotRunningError('r1'),
            new RoomTimeoutError('r1', 5000),
            new InvalidTagError('bad'),
        ];
        for (const err of errors) {
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(GathoError);
        }
    });
});

// -- helpers --

async function registerServerAndRoom(driver: Driver): Promise<void> {
    await driver._internal.registerServer({
        serverId: 's1',
        endpoint: 'http://localhost:3000',
        tags: {},
        roomTypes: ['game'],
    });
    await driver._internal.registerRoom('r1', 'game', 's1', {}, {});
}

async function getError(fn: () => Promise<unknown>): Promise<GathoError> {
    let caught: unknown;
    try {
        await fn();
    } catch (e) {
        caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(GathoError);
    return caught as GathoError;
}
