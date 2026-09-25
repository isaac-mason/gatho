import { describe, expect, it } from 'vitest';
import { RoomFailedError, RoomTimeoutError } from '../../src/driver/errors';
import type { RoomInfo } from '../../src/driver/types';
import { type RoomSignalHandlers, waitForRoomRunning } from '../../src/driver/wait-for-room';

function runningRoom(roomId: string): RoomInfo {
    return {
        roomId,
        roomType: 'game',
        serverId: 's1',
        status: 'running',
        endpoint: 'ws://127.0.0.1:1',
        clients: [],
        data: {},
        tags: {},
        createdAt: 0,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const noSignals = async (_handlers: RoomSignalHandlers) => () => {};

describe('waitForRoomRunning', () => {
    it('does not treat a read issued before registration as a removal, even if it resolves after', async () => {
        const firstRead = deferred<RoomInfo | null>();
        const registration = deferred<void>();
        let reads = 0;
        let running = false;

        const wait = waitForRoomRunning(
            'room-1',
            5_000,
            registration.promise,
            async () => {
                reads++;
                // the first read (issued before registration) stays in flight across it
                if (reads === 1) return firstRead.promise;
                return running ? runningRoom('room-1') : { ...runningRoom('room-1'), status: 'requested' };
            },
            noSignals,
        );
        let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
        wait.then(
            () => {
                outcome = 'resolved';
            },
            () => {
                outcome = 'rejected';
            },
        );

        registration.resolve();
        await new Promise((r) => setTimeout(r, 10));
        // the stale read now lands, after registration completed
        firstRead.resolve(null);
        await new Promise((r) => setTimeout(r, 10));
        expect(outcome).toBe('pending');

        running = true;
        await expect(wait).resolves.toMatchObject({ roomId: 'room-1', status: 'running' });
    });

    it('fails once the record is missing on a read issued after registration completed', async () => {
        const wait = waitForRoomRunning('room-1', 5_000, Promise.resolve(), async () => null, noSignals);
        await expect(wait).rejects.toBeInstanceOf(RoomFailedError);
    });

    it('keeps waiting while registration is still in flight, then times out', async () => {
        const wait = waitForRoomRunning('room-1', 50, new Promise<void>(() => {}), async () => null, noSignals);
        await expect(wait).rejects.toBeInstanceOf(RoomTimeoutError);
    });

    it('settles through polling when the ready signal is never delivered', async () => {
        let reads = 0;
        const wait = waitForRoomRunning(
            'room-1',
            5_000,
            Promise.resolve(),
            async () => {
                reads++;
                return reads < 2 ? { ...runningRoom('room-1'), status: 'requested' } : runningRoom('room-1');
            },
            noSignals,
        );
        await expect(wait).resolves.toMatchObject({ status: 'running' });
    });

    it('rejects with the failure reason carried by the failed signal', async () => {
        const wait = waitForRoomRunning(
            'room-1',
            5_000,
            Promise.resolve(),
            async () => ({ ...runningRoom('room-1'), status: 'requested' }),
            async (handlers) => {
                queueMicrotask(() => handlers.failed('bad image'));
                return () => {};
            },
        );
        await expect(wait).rejects.toMatchObject({ reason: 'bad image' });
    });

    it('rejects with the registration error when registration fails', async () => {
        const wait = waitForRoomRunning('room-1', 5_000, Promise.reject(new Error('no server')), async () => null, noSignals);
        await expect(wait).rejects.toThrow('no server');
    });
});
