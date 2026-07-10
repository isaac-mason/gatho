import type {
    ClientInfo,
    ClientReservation,
    Driver,
    ListRoomsFilter,
    ListServersFilter,
    RoomData,
    RoomInfo,
    RoomStatus,
    ServerInfo,
    TagFilter,
} from '../driver/types';

/** options for initializing the gatho sdk */
export type CreateGathoSDKOptions = {
    driver: Driver;
};

/** options for creating a room */
export type CreateRoomOptions = {
    /** room type */
    type: string;

    /** which server to place this room on */
    serverId: string;

    /** arbitrary data delivered to create() hook (immutable after creation).
     *  keep it small: it is pushed to the room on every assignment. */
    data: RoomData;

    /** mutable string key/value tags for userland categorization */
    tags: Record<string, string>;

    /** how long to wait for the room to become running (ms, default 10000).
     *
     *  this is a client-side backstop only. spawn failures (bad argv, missing
     *  image, crash on boot) now reject createRoom immediately with a
     *  RoomFailedError carrying the real reason — the timeout is not burned.
     *  the server's own roomStartupTimeoutMs (default 30000) governs how long a
     *  room may take to send its first notify message before the server kills it
     *  and reports failure; with fast failure the two no longer need to be
     *  aligned. keep timeoutMs comfortably above the slowest legitimate spawn
     *  (e.g. a cold docker image pull) so a slow-but-healthy start isn't cut off
     *  before the server has a chance to fail it. */
    timeoutMs?: number;
};

/** options for joining a room */
export type JoinOptions = {
    /** id of the room to join */
    roomId: string;

    /** how long until the reservation expires (ms) */
    ttl: number;

    /** arbitrary data included in the jwt and delivered to onAuth as joinData.
     *  keep small — the jwt travels in a url query param (~2-3KB practical limit). */
    data?: Record<string, unknown>;

    /** immutable string key/value tags persisted on the client record.
     *  visible on ClientInfo in listRooms / listServers responses. */
    tags?: Record<string, string>;
};

/** gatho sdk */
export type GathoSDK = {
    /** create a new room — registers then polls until status is 'running' */
    createRoom(options: CreateRoomOptions): Promise<RoomInfo>;

    /** destroy an existing room */
    destroyRoom(roomId: string): Promise<void>;

    /** join a room — mints a token for the user to connect with */
    join(options: JoinOptions): Promise<ClientReservation>;

    /** get information about a specific room */
    getRoom(roomId: string): Promise<RoomInfo | null>;

    /** list all rooms, optionally filtered */
    getRooms(filter?: ListRoomsFilter): Promise<RoomInfo[]>;

    /** list all servers, optionally filtered */
    getServers(filter?: ListServersFilter): Promise<ServerInfo[]>;

    /** add tags to a room */
    addRoomTags(roomId: string, tags: Record<string, string>): Promise<void>;

    /** remove tags from a room */
    removeRoomTags(roomId: string, keys: string[]): Promise<void>;

    /** add tags to a server */
    addServerTags(serverId: string, tags: Record<string, string>): Promise<void>;

    /** remove tags from a server */
    removeServerTags(serverId: string, keys: string[]): Promise<void>;
};

export type { ClientInfo, ClientReservation, ListRoomsFilter, ListServersFilter, RoomInfo, RoomStatus, ServerInfo, TagFilter };

// errors thrown by sdk calls — re-exported from `gatho/driver` (canonical home)
// so consumers don't have to import the driver module just to `instanceof` them.
export {
    GathoError,
    InvalidTagError,
    RoomFailedError,
    RoomNotFoundError,
    RoomNotRunningError,
    RoomStartError,
    RoomTimeoutError,
    ServerNotFoundError,
} from 'gatho/driver';

/** create a new gatho sdk instance with the given options */
export function createGathoSDK(options: CreateGathoSDKOptions): GathoSDK {
    const { _internal: driver } = options.driver;

    async function createRoom(opts: CreateRoomOptions): Promise<RoomInfo> {
        const roomId = crypto.randomUUID();
        const timeoutMs = opts.timeoutMs ?? 10_000;

        // start waiting before registering — the listener is in place before
        // the room even exists, so there's zero chance of missing the ready event
        const waitPromise = driver.waitForRoom(roomId, timeoutMs);

        await driver.registerRoom(roomId, opts.type, opts.serverId, opts.data, opts.tags);

        const info = await waitPromise.catch(async (err) => {
            await driver.unregisterRoom(roomId).catch(() => {});
            throw err;
        });

        return info;
    }

    async function destroyRoom(roomId: string): Promise<void> {
        await driver.unregisterRoom(roomId);
    }

    async function join(opts: JoinOptions): Promise<ClientReservation> {
        return driver.reserveClient(opts.roomId, opts.ttl, opts.data, opts.tags);
    }

    async function getRoom(roomId: string): Promise<RoomInfo | null> {
        return driver.getRoomInfo(roomId);
    }

    async function getRooms(filter?: ListRoomsFilter): Promise<RoomInfo[]> {
        return driver.listRooms(filter);
    }

    async function getServers(filter?: ListServersFilter): Promise<ServerInfo[]> {
        return driver.listServers(filter);
    }

    async function addRoomTags(roomId: string, tags: Record<string, string>): Promise<void> {
        return driver.addRoomTags(roomId, tags);
    }

    async function removeRoomTags(roomId: string, keys: string[]): Promise<void> {
        return driver.removeRoomTags(roomId, keys);
    }

    async function addServerTags(serverId: string, tags: Record<string, string>): Promise<void> {
        return driver.addServerTags(serverId, tags);
    }

    async function removeServerTags(serverId: string, keys: string[]): Promise<void> {
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
