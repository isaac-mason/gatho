import type { Driver } from './types';
/** options for creating an in-memory driver */
export type MemoryDriverOptions = {
    /**
     * how long (ms) a server may go without a heartbeat before it is treated as
     * dead — dropped from listServers and pruned (with its rooms) by the
     * background prune loop. defaults to 30_000.
     *
     * tradeoff: a lower value fails a dead server over faster, but is less
     * tolerant of transient blips; a higher value tolerates blips at the cost
     * of slower failover. must comfortably exceed the server's
     * heartbeatIntervalMs (default 5_000). rarely worth tuning for the memory
     * driver — it is single-process, so the only staleness source is a server
     * that genuinely stopped heartbeating.
     */
    staleServerMs?: number;
};
/**
 * An in-memory driver.
 * good for local development, tests, and situationally onebox dev environments.
 * note that you must pass the same driver object to both the server and sdk in order for them to see each other's state.
 */
export declare function createMemoryDriver(options?: MemoryDriverOptions): Driver;
