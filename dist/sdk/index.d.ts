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
     *  keep it small: it is pushed to the room on every assignment. */
    data: RoomData;
    /** mutable string key/value tags for userland categorization */
    tags: Record<string, string>;
    /** how long to wait for the room to become running (ms, default 10000) */
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
export { GathoError, InvalidTagError, RoomNotFoundError, RoomNotRunningError, RoomStartError, RoomTimeoutError, ServerNotFoundError, } from 'gatho/driver';
/** create a new gatho sdk instance with the given options */
export declare function createGathoSDK(options: CreateGathoSDKOptions): GathoSDK;
