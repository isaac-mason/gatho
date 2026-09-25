export { GathoError, InvalidTagError, RoomFailedError, RoomNotFoundError, RoomNotRunningError, RoomStartError, RoomTimeoutError, ServerNotFoundError } from 'gatho/driver';

// errors thrown by sdk calls — re-exported from `gatho/driver` (canonical home)
// so consumers don't have to import the driver module just to `instanceof` them.
// how much longer than the caller's wait a requested room record lives
const REQUESTED_ROOM_TTL_MARGIN_MS = 10_000;
/** create a new gatho sdk instance with the given options */
function createGathoSDK(options) {
    const { _internal: driver } = options.driver;
    async function createRoom(opts) {
        const roomId = crypto.randomUUID();
        const timeoutMs = opts.timeoutMs ?? 10_000;
        // listen before registering so a fast ready can't be missed
        let settleRegistration;
        const registered = new Promise((resolve, reject) => {
            settleRegistration = { resolve, reject };
        });
        const waitPromise = driver.waitForRoom(roomId, timeoutMs, registered);
        // outlives the wait, so a spawn started near the deadline still finds its record
        const ttlMs = Math.ceil(timeoutMs) + REQUESTED_ROOM_TTL_MARGIN_MS;
        try {
            await driver.registerRoom(roomId, opts.type, opts.serverId, opts.data ?? {}, opts.tags ?? {}, ttlMs);
        }
        catch (err) {
            settleRegistration.reject(err);
            await waitPromise.catch(() => undefined);
            throw err;
        }
        settleRegistration.resolve();
        return waitPromise.catch(async (err) => {
            await driver.unregisterRoom(roomId).catch(() => undefined);
            throw err;
        });
    }
    async function destroyRoom(roomId) {
        await driver.unregisterRoom(roomId);
    }
    // default reservation ttl: 30s.
    const DEFAULT_JOIN_TTL_MS = 30_000;
    async function join(opts) {
        return driver.reserveClient(opts.roomId, opts.ttl ?? DEFAULT_JOIN_TTL_MS, opts.data, opts.tags);
    }
    async function getRoom(roomId) {
        return driver.getRoomInfo(roomId);
    }
    async function getRooms(filter) {
        return driver.listRooms(filter);
    }
    async function getServers(filter) {
        return driver.listServers(filter);
    }
    async function addRoomTags(roomId, tags) {
        return driver.addRoomTags(roomId, tags);
    }
    async function removeRoomTags(roomId, keys) {
        return driver.removeRoomTags(roomId, keys);
    }
    async function addServerTags(serverId, tags) {
        return driver.addServerTags(serverId, tags);
    }
    async function removeServerTags(serverId, keys) {
        return driver.removeServerTags(serverId, keys);
    }
    return {
        createRoom,
        destroyRoom,
        join,
        getRoom,
        getRooms,
        getServers,
        addRoomTags,
        removeRoomTags,
        addServerTags,
        removeServerTags,
    };
}

export { createGathoSDK };
//# sourceMappingURL=sdk.js.map
