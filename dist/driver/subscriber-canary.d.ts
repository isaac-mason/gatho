/** how often a canary token is published */
export declare const CANARY_INTERVAL_MS = 5000;
/** how long after its PUBLISH resolves a token may go unreceived */
export declare const CANARY_TIMEOUT_MS = 10000;
/** how often tick() must be called */
export declare const CANARY_CHECK_MS = 1000;
/** worst-case time from a subscriber going deaf to reconnect() */
export declare const CANARY_DETECTION_BOUND_MS: number;
export type SubscriberCanary = {
    /** a token that arrived on the canary channel */
    received(token: string): void;
    /** advance the canary; call every CANARY_CHECK_MS */
    tick(): void;
};
/**
 * proves a subscriber still receives by publishing tokens to a channel it listens on.
 * a token counts as missed only once its PUBLISH has resolved, so a slow or dead
 * publishing connection is never blamed on the subscriber.
 */
export declare function createSubscriberCanary(publish: (token: string) => Promise<unknown>, isReady: () => boolean, reconnect: (missedMs: number) => void, now: () => number): SubscriberCanary;
