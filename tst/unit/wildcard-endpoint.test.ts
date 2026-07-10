// R2: fail fast on a wildcard serverEndpoint with a networked driver.
//
// a networked driver publishes this server's endpoint to peers and sdks. with an
// unset serverEndpoint and a wildcard bind host, the derived endpoint is
// http://0.0.0.0:port — unroutable, and every server registers the same one, so
// they mutually evict each other's rooms. start() must reject at startup in that
// case. a local (in-process) driver shares state directly, so the endpoint is
// moot and defaults must keep working.

import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/driver/memory';
import type { Driver } from '../../src/driver/types';
import { start } from '../../src/server/server';

// a stub networked driver — local: false — whose control-plane methods are inert.
// start() reads driver.local and (for the local case) drives the heartbeat loop;
// the fail-fast path throws before any driver method beyond `local` is touched.
function makeNetworkedStub(): Driver {
    const noop = async () => {};
    return {
        _internal: {
            local: false,
            registerRoom: noop,
            unregisterRoom: noop,
            roomReady: noop,
            roomFailure: noop,
            waitForRoom: async () => {
                throw new Error('unused');
            },
            getRoomInfo: async () => null,
            listRooms: async () => [],
            addRoomTags: noop,
            removeRoomTags: noop,
            reserveClient: async () => {
                throw new Error('unused');
            },
            connectClient: noop,
            disconnectClient: noop,
            heartbeat: async () => ({ tags: {}, desiredRooms: [], registered: true }),
            unregisterServer: noop,
            addServerTags: noop,
            removeServerTags: noop,
            listServers: async () => [],
            listStaleServers: async () => [],
            getServer: async () => null,
            subscribeRoomAssignments: async () => () => {},
            tryAcquireLeader: async () => false,
            renewLeader: async () => false,
            releaseLeader: noop,
        },
    };
}

const baseOptions = {
    rooms: {},
    roomEndpoint: ({ port }: { port: number }) => `ws://localhost:${port}`,
};

describe('wildcard serverEndpoint fail-fast', () => {
    it('throws when a networked driver has no serverEndpoint and binds a wildcard host', async () => {
        await expect(
            start({
                ...baseOptions,
                driver: makeNetworkedStub(),
                // host unset -> defaults to 0.0.0.0 (wildcard)
            }),
        ).rejects.toThrow(/serverEndpoint is required/);
    });

    it('throws for an explicit wildcard host too', async () => {
        await expect(
            start({
                ...baseOptions,
                driver: makeNetworkedStub(),
                host: '::',
            }),
        ).rejects.toThrow(/serverEndpoint is required/);
    });

    it('starts a networked driver when serverEndpoint is set explicitly', async () => {
        const server = await start({
            ...baseOptions,
            driver: makeNetworkedStub(),
            port: 0,
            serverEndpoint: 'http://10.0.0.5:3000',
        });
        await server.stop();
    });

    it('starts a networked driver when the bind host is concrete', async () => {
        const server = await start({
            ...baseOptions,
            driver: makeNetworkedStub(),
            host: '127.0.0.1',
            port: 0,
        });
        await server.stop();
    });

    it('starts a local (memory) driver with wildcard defaults', async () => {
        const driver = createMemoryDriver();
        const server = await start({
            ...baseOptions,
            driver,
            port: 0,
            // no host, no serverEndpoint — the onebox default must keep working
        });
        await server.stop();
        driver.destroy?.();
    });
});
