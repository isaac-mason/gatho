// typed domain errors for gatho
// all driver-layer errors extend GathoError so callers can catch broadly
// or narrowly via instanceof / .code switches.

/** base class for all gatho domain errors */
export class GathoError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = this.constructor.name;
    }
}

/** thrown when a server id doesn't exist in the registry */
export class ServerNotFoundError extends GathoError {
    readonly serverId: string;

    constructor(serverId: string) {
        super('server-not-found', `server not found: ${serverId}`);
        this.serverId = serverId;
    }
}

/** thrown when a room id doesn't exist in the registry */
export class RoomNotFoundError extends GathoError {
    readonly roomId: string;

    constructor(roomId: string) {
        super('room-not-found', `room not found: ${roomId}`);
        this.roomId = roomId;
    }
}

/** thrown when a room exists but isn't in 'running' status yet */
export class RoomNotRunningError extends GathoError {
    readonly roomId: string;

    constructor(roomId: string) {
        super('room-not-running', `room is not running yet: ${roomId}`);
        this.roomId = roomId;
    }
}

/** thrown when waitForRoom times out before the room becomes running */
export class RoomTimeoutError extends GathoError {
    readonly roomId: string;
    readonly timeoutMs: number;

    constructor(roomId: string, timeoutMs: number) {
        super('room-timeout', `room ${roomId} did not become running within ${timeoutMs}ms`);
        this.roomId = roomId;
        this.timeoutMs = timeoutMs;
    }
}

/** thrown when a room fails to start (spawn failure, worker crash, stalled heartbeat)
 *  while a waiter is blocked on waitForRoom. carries the failure reason so callers
 *  learn the real cause immediately instead of burning the full startup timeout. */
export class RoomFailedError extends GathoError {
    readonly roomId: string;
    readonly reason: string;

    constructor(roomId: string, reason: string) {
        super('room-failed', `room ${roomId} failed to start: ${reason}`);
        this.roomId = roomId;
        this.reason = reason;
    }
}

/** thrown when a room was confirmed running but its data couldn't be fetched (race condition) */
export class RoomStartError extends GathoError {
    readonly roomId: string;

    constructor(roomId: string) {
        super('room-start-failed', `room ${roomId} was ready but could not be retrieved`);
        this.roomId = roomId;
    }
}

/** thrown when a tag key or value fails validation */
export class InvalidTagError extends GathoError {
    readonly detail: string;

    constructor(detail: string) {
        super('invalid-tag', detail);
        this.detail = detail;
    }
}

/** thrown when a driver receives invalid configuration (bad schema name, prefix, etc.) */
export class DriverConfigError extends GathoError {
    readonly detail: string;

    constructor(detail: string) {
        super('driver-config', detail);
        this.detail = detail;
    }
}

/** thrown when reserveClient receives a `data` or `tags` argument whose serialized
 *  size would push the resulting jwt past url/header limits on the upgrade request. */
export class PayloadTooLargeError extends GathoError {
    readonly field: 'data' | 'tags';
    readonly sizeBytes: number;
    readonly limitBytes: number;

    constructor(field: 'data' | 'tags', sizeBytes: number, limitBytes: number) {
        super('payload-too-large', `${field} too large: ${sizeBytes}B exceeds limit of ${limitBytes}B`);
        this.field = field;
        this.sizeBytes = sizeBytes;
        this.limitBytes = limitBytes;
    }
}
