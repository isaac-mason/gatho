import { createHmac } from 'node:crypto';

// minimal hmac-sha256 jwt — no external deps.
// single source of truth for sign + verify across drivers and room workers.
// static header — always the same, computed once
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
/** sign a payload with hs256, returns a compact jwt string */
function jwtSign(payload, secret) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(`${JWT_HEADER}.${body}`).digest('base64url');
    return `${JWT_HEADER}.${body}.${signature}`;
}
/** verify a compact jwt string, returns the payload or null if invalid/expired */
function jwtVerify(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;
    const [header, body, signature] = parts;
    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    if (signature !== expected)
        return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof payload.exp === 'number' && Date.now() > payload.exp)
        return null;
    return payload;
}

// typed domain errors for gatho
// all driver-layer errors extend GathoError so callers can catch broadly
// or narrowly via instanceof / .code switches.
/** base class for all gatho domain errors */
class GathoError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = this.constructor.name;
    }
}
/** thrown when a server id doesn't exist in the registry */
class ServerNotFoundError extends GathoError {
    serverId;
    constructor(serverId) {
        super('server-not-found', `server not found: ${serverId}`);
        this.serverId = serverId;
    }
}
/** thrown when a room id doesn't exist in the registry */
class RoomNotFoundError extends GathoError {
    roomId;
    constructor(roomId) {
        super('room-not-found', `room not found: ${roomId}`);
        this.roomId = roomId;
    }
}
/** thrown when a room exists but isn't in 'running' status yet */
class RoomNotRunningError extends GathoError {
    roomId;
    constructor(roomId) {
        super('room-not-running', `room is not running yet: ${roomId}`);
        this.roomId = roomId;
    }
}
/** thrown when waitForRoom times out before the room becomes running */
class RoomTimeoutError extends GathoError {
    roomId;
    timeoutMs;
    constructor(roomId, timeoutMs) {
        super('room-timeout', `room ${roomId} did not become running within ${timeoutMs}ms`);
        this.roomId = roomId;
        this.timeoutMs = timeoutMs;
    }
}
/** thrown when a room was confirmed running but its data couldn't be fetched (race condition) */
class RoomStartError extends GathoError {
    roomId;
    constructor(roomId) {
        super('room-start-failed', `room ${roomId} was ready but could not be retrieved`);
        this.roomId = roomId;
    }
}
/** thrown when a tag key or value fails validation */
class InvalidTagError extends GathoError {
    detail;
    constructor(detail) {
        super('invalid-tag', detail);
        this.detail = detail;
    }
}
/** thrown when a driver receives invalid configuration (bad schema name, prefix, etc.) */
class DriverConfigError extends GathoError {
    detail;
    constructor(detail) {
        super('driver-config', detail);
        this.detail = detail;
    }
}

export { DriverConfigError, GathoError, InvalidTagError, RoomNotFoundError, RoomNotRunningError, RoomStartError, RoomTimeoutError, ServerNotFoundError, jwtSign, jwtVerify };
//# sourceMappingURL=common.js.map
