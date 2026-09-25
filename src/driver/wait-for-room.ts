import { log } from '../common/logger';
import { RoomFailedError, RoomStartError, RoomTimeoutError } from './errors';
import type { RoomInfo } from './types';

// how often a waiter re-reads the room record, independent of pub/sub signals
const WAIT_FOR_ROOM_POLL_MS = 1_000;

export type RoomSignalHandlers = {
    ready: () => void;
    failed: (reason: string) => void;
};

/** shared waitForRoom for every driver: signals make it fast, the record poll guarantees it settles. */
export function waitForRoomRunning(
    roomId: string,
    timeoutMs: number,
    registered: Promise<void>,
    getRoomInfo: (roomId: string) => Promise<RoomInfo | null>,
    subscribeSignals: (handlers: RoomSignalHandlers) => Promise<() => void>,
): Promise<RoomInfo> {
    return new Promise<RoomInfo>((resolve, reject) => {
        let settled = false;
        let isRegistered = false;
        let unsubscribe: (() => void) | null = null;

        const finish = (outcome: { info: RoomInfo } | { error: Error }): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            unsubscribe?.();
            if ('info' in outcome) resolve(outcome.info);
            else reject(outcome.error);
        };

        // after a ready signal, a missing record is a start error rather than a removal
        const check = (afterReadySignal: boolean): void => {
            // a read issued before registration can resolve after it; judge its miss by when it was issued
            const registeredWhenIssued = isRegistered;
            getRoomInfo(roomId).then(
                (info) => {
                    if (settled) return;
                    if (info?.status === 'running') {
                        finish({ info });
                    } else if (!info && afterReadySignal) {
                        finish({ error: new RoomStartError(roomId) });
                    } else if (!info && registeredWhenIssued) {
                        finish({ error: new RoomFailedError(roomId, 'room record removed') });
                    }
                },
                (err: unknown) => {
                    // a transient read failure doesn't fail the wait; the next poll or the timeout decides
                    log.warn('waitForRoom poll failed', { roomId, err });
                },
            );
        };

        const timer = setTimeout(() => finish({ error: new RoomTimeoutError(roomId, timeoutMs) }), timeoutMs);
        const poll = setInterval(() => check(false), WAIT_FOR_ROOM_POLL_MS);

        registered.then(
            () => {
                isRegistered = true;
                check(false);
            },
            (err: unknown) => finish({ error: err instanceof Error ? err : new Error(String(err)) }),
        );

        subscribeSignals({
            ready: () => check(true),
            failed: (reason) => finish({ error: new RoomFailedError(roomId, reason) }),
        }).then(
            (unsub) => {
                if (settled) {
                    unsub();
                    return;
                }
                unsubscribe = unsub;
                // a ready published before the subscription landed was missed; look now
                check(false);
            },
            (err: unknown) => {
                // polling still settles the wait; only the fast path is lost
                log.warn('waitForRoom signal subscription failed, relying on polling', { roomId, err });
            },
        );

        check(false);
    });
}
