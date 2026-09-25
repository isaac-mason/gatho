/** how often a canary token is published */
export const CANARY_INTERVAL_MS = 5_000;
/** how long after its PUBLISH resolves a token may go unreceived */
export const CANARY_TIMEOUT_MS = 10_000;
/** how often tick() must be called */
export const CANARY_CHECK_MS = 1_000;
/** worst-case time from a subscriber going deaf to reconnect() */
export const CANARY_DETECTION_BOUND_MS = CANARY_INTERVAL_MS + CANARY_TIMEOUT_MS + CANARY_CHECK_MS;

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
export function createSubscriberCanary(
    publish: (token: string) => Promise<unknown>,
    isReady: () => boolean,
    reconnect: (missedMs: number) => void,
    now: () => number,
): SubscriberCanary {
    let sequence = 0;
    let lastSentAt = Number.NEGATIVE_INFINITY;
    // publishedAt is null until the PUBLISH resolves
    let outstanding: { token: string; publishedAt: number | null } | null = null;

    return {
        received(token) {
            if (outstanding?.token === token) outstanding = null;
        },
        tick() {
            if (!isReady()) {
                outstanding = null;
                return;
            }
            const at = now();
            if (outstanding) {
                const { publishedAt } = outstanding;
                if (publishedAt !== null && at - publishedAt > CANARY_TIMEOUT_MS) {
                    outstanding = null;
                    reconnect(at - publishedAt);
                }
                return;
            }
            if (at - lastSentAt < CANARY_INTERVAL_MS) return;
            lastSentAt = at;
            const canary: { token: string; publishedAt: number | null } = { token: String(++sequence), publishedAt: null };
            outstanding = canary;
            publish(canary.token).then(
                () => {
                    canary.publishedAt = now();
                },
                () => {
                    // the publishing connection's trouble, not the subscriber's
                    if (outstanding === canary) outstanding = null;
                },
            );
        },
    };
}
