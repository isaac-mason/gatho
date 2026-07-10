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
/** thrown when a room fails to start (spawn failure, worker crash, stalled heartbeat)
 *  while a waiter is blocked on waitForRoom. carries the failure reason so callers
 *  learn the real cause immediately instead of burning the full startup timeout. */
export declare class RoomFailedError extends GathoError {
    readonly roomId: string;
    readonly reason: string;
    constructor(roomId: string, reason: string);
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
/** thrown when reserveClient receives a `data` or `tags` argument whose serialized
 *  size would push the resulting jwt past url/header limits on the upgrade request. */
export declare class PayloadTooLargeError extends GathoError {
    readonly field: 'data' | 'tags';
    readonly sizeBytes: number;
    readonly limitBytes: number;
    constructor(field: 'data' | 'tags', sizeBytes: number, limitBytes: number);
}
