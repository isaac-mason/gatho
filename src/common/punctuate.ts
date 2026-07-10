import { log as defaultLog, type Logger } from './logger';

export type Punctuator = { stop: () => void };

export type PunctuateOptions = {
    /** target gap between successive starts. if a run exceeds this, the next run fires immediately. */
    intervalMs: number;
    /** maximum time a single run may take before it is rejected with a timeout error. */
    timeoutMs: number;
    /** logger used for error logs. defaults to the module-level logger. pass a child
     *  logger (e.g. `log.child({ serverId })`) to attach context to error lines. */
    logger?: Logger;
};

/** race a promise against a timeout. rejects with `${label} timeout` if it doesn't
 *  settle in time. `onTimeout` (if given) fires synchronously when the timeout wins
 *  the race — the underlying promise is not cancelled, so this is the hook to mark
 *  its result stale. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    onTimeout?.();
                    reject(new Error(`${label} timeout`));
                }, ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * schedule async work on a self-pacing cadence.
 *
 * the first tick runs eagerly and is awaited before this function returns; the
 * caller can rely on `run` having executed once (success or caught error) by
 * the time the resulting Punctuator handle is in hand. each subsequent tick is
 * scheduled `intervalMs` after the previous one's start (or immediately if the
 * previous run exceeded the interval). avoids both pending-promise pile-up
 * (no overlap by construction) and the "skip a full interval" gap that
 * setInterval + skip-on-overlap produces when a run runs long.
 *
 * `run` receives an `isCurrent()` predicate. it returns true while this tick is
 * still the live one and becomes false the instant the tick times out (the next
 * tick may then start) or the punctuator is stopped. withTimeout rejects a slow
 * run but cannot cancel the underlying promise — it keeps executing. a run that
 * outlives its timeout MUST check isCurrent() before any destructive action so
 * it doesn't act on conclusions drawn from now-stale state while a fresh tick is
 * already reconciling.
 */
export async function punctuate(
    label: string,
    run: (isCurrent: () => boolean) => Promise<void>,
    opts: PunctuateOptions,
): Promise<Punctuator> {
    const log = opts.logger ?? defaultLog;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // monotonically increasing tick epoch. a run captures its epoch on entry;
    // isCurrent() reads true only while the live epoch still matches. the epoch
    // advances the moment a run stops being authoritative — on timeout, on
    // stop, or when the run completes and the next tick is scheduled — so an
    // orphaned run (rejected by withTimeout but still executing) sees false.
    let epoch = 0;

    function stop(): void {
        stopped = true;
        epoch++;
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    }

    async function tick(): Promise<void> {
        if (stopped) return;
        const startedAt = Date.now();
        const myEpoch = epoch;
        const isCurrent = () => !stopped && epoch === myEpoch;

        try {
            // onTimeout advances the epoch so the still-executing run's
            // isCurrent() flips to false the instant the tick is abandoned.
            await withTimeout(run(isCurrent), opts.timeoutMs, label, () => {
                if (epoch === myEpoch) epoch++;
            });
        } catch (err) {
            log.error(`${label} error`, { err });
        }

        if (stopped) return;
        const elapsed = Date.now() - startedAt;
        const delay = Math.max(0, opts.intervalMs - elapsed);
        // advance the epoch (idempotent if the timeout already did) so the
        // just-finished run — and any orphaned timed-out run — reads not-current,
        // then schedule the next tick with its own fresh epoch.
        if (epoch === myEpoch) epoch++;
        timer = setTimeout(tick, delay);
    }

    await tick();
    return { stop };
}
