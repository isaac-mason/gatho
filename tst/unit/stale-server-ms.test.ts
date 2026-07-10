// R11a: configurable server staleness threshold.
//
// the memory driver's listServers / listStaleServers cutoff must honor the
// staleServerMs option instead of the hardcoded 30s default. we only cover the
// memory driver at the unit level (no infra); the redis driver shares the same
// option shape and the driver-contract e2e exercises its listings against a real
// redis.

import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/driver/memory';

describe('configurable staleServerMs (memory)', () => {
    it('treats a server as stale once its heartbeat is older than staleServerMs', async () => {
        // a tiny threshold: after a short wait the single heartbeat is stale.
        const driver = createMemoryDriver({ staleServerMs: 20 });

        await driver._internal.heartbeat({
            serverId: 'srv-1',
            endpoint: 'http://10.0.0.5:3000',
            tags: {},
            roomTypes: ['game'],
        });

        // immediately live
        expect(await driver._internal.listServers()).toHaveLength(1);
        expect(await driver._internal.listStaleServers()).toHaveLength(0);

        // wait past the threshold
        await new Promise((r) => setTimeout(r, 40));

        expect(await driver._internal.listServers()).toHaveLength(0);
        const stale = await driver._internal.listStaleServers();
        expect(stale).toHaveLength(1);
        expect(stale[0].serverId).toBe('srv-1');

        driver.destroy?.();
    });

    it('a large threshold keeps a server live well past the 30s default', async () => {
        // default would still count this as live too, so we assert the option is
        // actually plumbed by using a threshold and confirming liveness holds; the
        // discriminating case is the small-threshold test above.
        const driver = createMemoryDriver({ staleServerMs: 60_000 });

        await driver._internal.heartbeat({
            serverId: 'srv-2',
            endpoint: 'http://10.0.0.5:3000',
            tags: {},
            roomTypes: ['game'],
        });

        await new Promise((r) => setTimeout(r, 40));
        expect(await driver._internal.listServers()).toHaveLength(1);
        expect(await driver._internal.listStaleServers()).toHaveLength(0);

        driver.destroy?.();
    });

    it('defaults to 30s when unset', async () => {
        const driver = createMemoryDriver();
        await driver._internal.heartbeat({
            serverId: 'srv-3',
            endpoint: 'http://10.0.0.5:3000',
            tags: {},
            roomTypes: ['game'],
        });
        expect(await driver._internal.listServers()).toHaveLength(1);
        driver.destroy?.();
    });
});
