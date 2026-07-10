import type { ClientInfo, ClientReservation, Driver, ListRoomsFilter, ListServersFilter, RoomData, RoomInfo, RoomStatus, ServerInfo, TagFilter } from '../driver/types';
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
     *  keep it small: it is pushed to the room on every assignment.
     *  optional — defaults to `{}`. */
    data?: RoomData;
    /** mutable string key/value tags for userland categorization.
     *  optional — defaults to `{}`. */
    tags?: Record<string, string>;
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
    /** how long until the reservation expires (ms). optional — defaults to 30000. */
    ttl?: number;
    /** arbitrary data included in the jwt and delivered to onAuth as joinData.
     *  keep it small — the whole jwt travels in a url query param, and urls have a
     *  ~8KB practical limit across proxies and servers. capped at 2048 bytes
     *  serialized; join() throws PayloadTooLargeError if exceeded. */
    data?: Record<string, unknown>;
    /** immutable string key/value tags persisted on the client record.
     *  visible on ClientInfo in listRooms / listServers responses. capped at 512
     *  bytes serialized; join() throws PayloadTooLargeError if exceeded. */
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
export { GathoError, InvalidTagError, RoomFailedError, RoomNotFoundError, RoomNotRunningError, RoomStartError, RoomTimeoutError, ServerNotFoundError, } from 'gatho/driver';
/** create a new gatho sdk instance with the given options */
export declare function createGathoSDK(options: CreateGathoSDKOptions): GathoSDK;
