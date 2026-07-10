export { GathoError, InvalidTagError, RoomFailedError, RoomNotFoundError, RoomNotRunningError, RoomStartError, RoomTimeoutError, ServerNotFoundError } from 'gatho/driver';

// errors thrown by sdk calls — re-exported from `gatho/driver` (canonical home)
// so consumers don't have to import the driver module just to `instanceof` them.
/** create a new gatho sdk instance with the given options */
function createGathoSDK(options) {
    const { _internal: driver } = options.driver;
    async function createRoom(opts) {
        const roomId = crypto.randomUUID();
        const timeoutMs = opts.timeoutMs ?? 10_000;
        // start waiting before registering — the listener is in place before
        // the room even exists, so there's zero chance of missing the ready event
        const waitPromise = driver.waitForRoom(roomId, timeoutMs);
        await driver.registerRoom(roomId, opts.type, opts.serverId, opts.data, opts.tags);
        const info = await waitPromise.catch(async (err) => {
            await driver.unregisterRoom(roomId).catch(() => { });
            throw err;
        });
        return info;
    }
    async function destroyRoom(roomId) {
        await driver.unregisterRoom(roomId);
    }
    async function join(opts) {
        return driver.reserveClient(opts.roomId, opts.ttl, opts.data, opts.tags);
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
