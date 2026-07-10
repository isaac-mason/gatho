// R12: a punctuate run that outlives its timeout must not act on stale
// conclusions. withTimeout rejects a slow run but cannot cancel the underlying
// promise — it keeps executing while the next tick starts. run() now receives an
// isCurrent() predicate that flips to false the instant the tick times out or the
// punctuator stops, so the orphaned run can guard its destructive tail.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { punctuate } from '../../src/common/punctuate';
import type { Logger } from '../../src/common/logger';

// silence the punctuate error log (timed-out runs reject and get logged).
const silentLogger: Logger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => silentLogger,
};

describe('punctuate currency', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports isCurrent() === false after the tick times out', async () => {
        // a run that never resolves on its own: we resolve it manually AFTER the
        // timeout fires and assert its captured isCurrent() reads false by then.
        let resolveRun!: () => void;
        let seenCurrentAtEnd: boolean | null = null;

        const runPromise = new Promise<void>((r) => {
            resolveRun = r;
        });

        const p = punctuate(
            'test',
            async (isCurrent) => {
                await runPromise;
                seenCurrentAtEnd = isCurrent();
            },
            { intervalMs: 1_000, timeoutMs: 100, logger: silentLogger },
        );

        // let the eager first tick start; advance past the timeout so withTimeout
        // rejects and the epoch advances.
        await vi.advanceTimersByTimeAsync(150);

        // the run itself is still pending (it awaits runPromise). release it now —
        // it should observe isCurrent() === false because its tick timed out.
        resolveRun();
        await Promise.resolve();
        await Promise.resolve();

        expect(seenCurrentAtEnd).toBe(false);

        (await p).stop();
    });

    it('reports isCurrent() === true for a run that completes within the timeout', async () => {
        let seenCurrent: boolean | null = null;

        const p = await punctuate(
            'test',
            async (isCurrent) => {
                seenCurrent = isCurrent();
            },
            { intervalMs: 1_000, timeoutMs: 100, logger: silentLogger },
        );

        expect(seenCurrent).toBe(true);
        p.stop();
    });

    it('reports isCurrent() === false to a run in flight when stop() is called', async () => {
        // tick 1 completes fast so punctuate() resolves; tick 2 blocks on a gate
        // we hold open. we stop() while tick 2 is in flight, then release it and
        // assert its isCurrent() read false.
        let tick = 0;
        let releaseSecond!: () => void;
        let secondSawCurrent: boolean | null = null;
        const secondGate = new Promise<void>((r) => {
            releaseSecond = r;
        });

        const p = await punctuate(
            'test',
            async (isCurrent) => {
                tick++;
                if (tick === 2) {
                    await secondGate;
                    secondSawCurrent = isCurrent();
                }
            },
            { intervalMs: 1_000, timeoutMs: 10_000, logger: silentLogger },
        );

        // advance to fire tick 2, which now blocks on secondGate.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(tick).toBe(2);

        p.stop();
        releaseSecond();
        await Promise.resolve();
        await Promise.resolve();

        expect(secondSawCurrent).toBe(false);
    });

    it('does not overlap ticks: the next tick waits for the interval from start', async () => {
        const starts: number[] = [];
        const p = await punctuate(
            'test',
            async () => {
                starts.push(Date.now());
            },
            { intervalMs: 1_000, timeoutMs: 500, logger: silentLogger },
        );

        expect(starts.length).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(starts.length).toBe(2);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(starts.length).toBe(3);
        p.stop();
    });
});
