/** base class for all gatho domain errors */
export declare class GathoError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** thrown when a server id doesn't exist in the registry */
export declare class ServerNotFoundError extends GathoError {
    readonly serverId: string;
    constructor(serverId: string);
}
/** thrown when a room id doesn't exist in the registry */
export declare class RoomNotFoundError extends GathoError {
    readonly roomId: string;
    constructor(roomId: string);
}
/** thrown when a room exists but isn't in 'running' status yet */
export declare class RoomNotRunningError extends GathoError {
    readonly roomId: string;
    constructor(roomId: string);
}
/** thrown when waitForRoom times out before the room becomes running */
export declare class RoomTimeoutError extends GathoError {
    readonly roomId: string;
    readonly timeoutMs: number;
    constructor(roomId: string, timeoutMs: number);
}
/** thrown when a room was confirmed running but its data couldn't be fetched (race condition) */
export declare class RoomStartError extends GathoError {
    readonly roomId: string;
    constructor(roomId: string);
}
/** thrown when a tag key or value fails validation */
export declare class InvalidTagError extends GathoError {
    readonly detail: string;
    constructor(detail: string);
}
/** thrown when a driver receives invalid configuration (bad schema name, prefix, etc.) */
export declare class DriverConfigError extends GathoError {
    readonly detail: string;
    constructor(detail: string);
}
