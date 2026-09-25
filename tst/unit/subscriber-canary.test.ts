import { describe, expect, it } from 'vitest';
import {
    CANARY_CHECK_MS,
    CANARY_DETECTION_BOUND_MS,
    CANARY_INTERVAL_MS,
    CANARY_TIMEOUT_MS,
    createSubscriberCanary,
    type SubscriberCanary,
} from '../../src/driver/subscriber-canary';

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

type Harness = {
    canary: SubscriberCanary;
    clock: { now: number };
    publishes: () => number;
    reconnects: () => number[];
    // advances the clock by whole check intervals, ticking at each like the driver's timer
    runFor: (ms: number) => Promise<void>;
};

// a canary over a manual clock; `deliver(now)` decides whether a token published at `now` arrives
function harness(
    deliver: (now: number) => boolean,
    publishOutcome: 'resolves' | 'rejects' | 'hangs' = 'resolves',
    isReady: () => boolean = () => true,
): Harness {
    const clock = { now: 0 };
    let publishes = 0;
    const reconnects: number[] = [];
    const canary: SubscriberCanary = createSubscriberCanary(
        (token) => {
            publishes++;
            if (publishOutcome === 'hangs') return new Promise(() => {});
            if (publishOutcome === 'rejects') return Promise.reject(new Error('publish failed'));
            if (deliver(clock.now)) queueMicrotask(() => canary.received(token));
            return Promise.resolve();
        },
        isReady,
        () => reconnects.push(clock.now),
        () => clock.now,
    );
    return {
        canary,
        clock,
        publishes: () => publishes,
        reconnects: () => reconnects,
        runFor: async (ms) => {
            const until = clock.now + ms;
            while (clock.now < until) {
                canary.tick();
                await flushMicrotasks();
                clock.now += CANARY_CHECK_MS;
            }
        },
    };
}

describe('subscriber canary', () => {
    it('never reconnects a subscriber that keeps receiving', async () => {
        const h = harness(() => true);
        await h.runFor(10 * 60_000);
        expect(h.reconnects()).toEqual([]);
        expect(h.publishes()).toBeGreaterThanOrEqual((10 * 60_000) / CANARY_INTERVAL_MS - 1);
    });

    it('reconnects a deaf subscriber after the timeout and within the detection bound, whatever the phase', async () => {
        // deafness can begin at any moment relative to the publish schedule
        for (let deafFrom = 0; deafFrom < 4 * CANARY_INTERVAL_MS; deafFrom += 250) {
            const h = harness((now) => now < deafFrom);
            await h.runFor(deafFrom + 3 * CANARY_DETECTION_BOUND_MS);

            const [firstReconnect] = h.reconnects();
            expect(firstReconnect, `deaf from ${deafFrom}ms`).toBeDefined();
            const detectionMs = firstReconnect - deafFrom;
            expect(detectionMs, `deaf from ${deafFrom}ms`).toBeGreaterThan(CANARY_TIMEOUT_MS);
            expect(detectionMs, `deaf from ${deafFrom}ms`).toBeLessThanOrEqual(CANARY_DETECTION_BOUND_MS);
        }
    });

    it('keeps probing after a reconnect and stops reconnecting once tokens arrive again', async () => {
        let deaf = true;
        const h = harness(() => !deaf);
        await h.runFor(2 * CANARY_DETECTION_BOUND_MS);
        expect(h.reconnects().length).toBeGreaterThan(0);

        deaf = false;
        const reconnectsWhileDeaf = h.reconnects().length;
        await h.runFor(10 * CANARY_DETECTION_BOUND_MS);
        // at most the one already in flight when delivery resumed
        expect(h.reconnects().length - reconnectsWhileDeaf).toBeLessThanOrEqual(1);
    });

    it('never blames the subscriber when its publish never completes', async () => {
        const h = harness(() => false, 'hangs');
        await h.runFor(10 * CANARY_DETECTION_BOUND_MS);
        expect(h.reconnects()).toEqual([]);
    });

    it('never blames the subscriber when its publish fails, and keeps publishing', async () => {
        const h = harness(() => false, 'rejects');
        await h.runFor(10 * CANARY_DETECTION_BOUND_MS);
        expect(h.reconnects()).toEqual([]);
        expect(h.publishes()).toBeGreaterThan(10);
    });

    it('does not publish or judge while the subscriber is not ready', async () => {
        let ready = false;
        const h = harness(
            () => false,
            'resolves',
            () => ready,
        );
        await h.runFor(10 * CANARY_DETECTION_BOUND_MS);
        expect(h.publishes()).toBe(0);
        expect(h.reconnects()).toEqual([]);

        ready = true;
        await h.runFor(2 * CANARY_DETECTION_BOUND_MS);
        expect(h.publishes()).toBeGreaterThan(0);
        expect(h.reconnects().length).toBeGreaterThan(0);
    });
});
