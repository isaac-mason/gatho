import { type Logger } from './logger';
export type Punctuator = {
    stop: () => void;
};
export type PunctuateOptions = {
    /** target gap between successive starts. if a run exceeds this, the next run fires immediately. */
    intervalMs: number;
    /** maximum time a single run may take before it is rejected with a timeout error. */
    timeoutMs: number;
    /** logger used for error logs. defaults to the module-level logger. pass a child
     *  logger (e.g. `log.child({ serverId })`) to attach context to error lines. */
    logger?: Logger;
};
/** race a promise against a timeout. rejects with `${label} timeout` if it doesn't settle in time. */
export declare function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T>;
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
 */
export declare function punctuate(label: string, run: () => Promise<void>, opts: PunctuateOptions): Promise<Punctuator>;
