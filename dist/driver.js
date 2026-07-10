import { EventEmitter } from 'node:events';

// minimal hmac-sha256 jwt — no external deps.
// single source of truth for sign + verify across drivers and rooms.
//
// built on WebCrypto (async) rather than node:crypto so the verify side runs
// in any runtime a room might be hosted in (node, workerd, deno, bun).
const encoder = new TextEncoder();
function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
// CryptoKey cache — importKey is an async round-trip and sign/verify sit on hot
// paths (every reservation, every ws upgrade). keyed by usage+secret; capped so
// a long-lived process signing for many rooms doesn't grow unboundedly (Map
// iteration order = insertion order, so evicting the first entry is FIFO).
const KEY_CACHE_MAX = 256;
const keyCache = new Map();
function hmacKey(secret, usage) {
    const cacheKey = `${usage}:${secret}`;
    const cached = keyCache.get(cacheKey);
    if (cached)
        return cached;
    const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
    if (keyCache.size >= KEY_CACHE_MAX) {
        const oldest = keyCache.keys().next().value;
        if (oldest !== undefined)
            keyCache.delete(oldest);
    }
    keyCache.set(cacheKey, key);
    key.catch(() => keyCache.delete(cacheKey));
    return key;
}
// static header — always the same, computed once
const JWT_HEADER = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
/** sign a payload with hs256, returns a compact jwt string */
async function jwtSign(payload, secret) {
    const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
    const key = await hmacKey(secret, 'sign');
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${JWT_HEADER}.${body}`)));
    return `${JWT_HEADER}.${body}.${toBase64Url(signature)}`;
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
/** thrown when a room fails to start (spawn failure, worker crash, stalled heartbeat)
 *  while a waiter is blocked on waitForRoom. carries the failure reason so callers
 *  learn the real cause immediately instead of burning the full startup timeout. */
class RoomFailedError extends GathoError {
    roomId;
    reason;
    constructor(roomId, reason) {
        super('room-failed', `room ${roomId} failed to start: ${reason}`);
        this.roomId = roomId;
        this.reason = reason;
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
/** thrown when reserveClient receives a `data` or `tags` argument whose serialized
 *  size would push the resulting jwt past url/header limits on the upgrade request. */
class PayloadTooLargeError extends GathoError {
    field;
    sizeBytes;
    limitBytes;
    constructor(field, sizeBytes, limitBytes) {
        super('payload-too-large', `${field} too large: ${sizeBytes}B exceeds limit of ${limitBytes}B`);
        this.field = field;
        this.sizeBytes = sizeBytes;
        this.limitBytes = limitBytes;
    }
}

// --- tag validation ---
const VALID_TAG_RE = /^[a-zA-Z0-9_-]+$/;
/** validate a tag key — must be alphanumeric/hyphen/underscore, must not start with _ (reserved for internal use) */
function validateTagKey(key) {
    if (!VALID_TAG_RE.test(key)) {
        throw new InvalidTagError(`invalid tag key "${key}" — must match [a-zA-Z0-9_-]+`);
    }
    if (key.startsWith('_')) {
        throw new InvalidTagError(`tag key "${key}" is reserved (starts with _)`);
    }
}
/** validate a tag value — must be alphanumeric/hyphen/underscore */
function validateTagValue(value) {
    if (!VALID_TAG_RE.test(value)) {
        throw new InvalidTagError(`invalid tag value "${value}" — must match [a-zA-Z0-9_-]+`);
    }
}
/** validate all keys and values in a tags record */
function validateTags(tags) {
    for (const [key, value] of Object.entries(tags)) {
        validateTagKey(key);
        validateTagValue(value);
    }
}
// --- payload size validation ---
//
// the reservation jwt travels as a `?token=...` query param on the ws upgrade url.
// proxies (cloudflare, nginx) and browsers cluster around 8KB request-line limits.
// fail eagerly here so callers see a typed error instead of a silent upgrade failure
// in some environments. limits are conservative defaults — bump them in code (and
// update the matching tests) if a legitimate use case needs more.
/** maximum serialized size of the user-supplied `data` claim on a reservation jwt. */
const RESERVE_DATA_MAX_BYTES = 2048;
/** maximum serialized size of the driver-internal `tags` record on a reservation jwt. */
const RESERVE_TAGS_MAX_BYTES = 512;
/** validate that `data` will fit in the reservation jwt without blowing url limits. */
function validateReserveData(data) {
    const size = Buffer.byteLength(JSON.stringify(data ?? {}));
    if (size > RESERVE_DATA_MAX_BYTES) {
        throw new PayloadTooLargeError('data', size, RESERVE_DATA_MAX_BYTES);
    }
}
/** validate that `tags` will fit in the reservation jwt without blowing url limits. */
function validateReserveTagsSize(tags) {
    const size = Buffer.byteLength(JSON.stringify(tags));
    if (size > RESERVE_TAGS_MAX_BYTES) {
        throw new PayloadTooLargeError('tags', size, RESERVE_TAGS_MAX_BYTES);
    }
}

// in-memory driver for dev mode
// single-process, no persistence
// used by 'gatho dev' where server and sdk are in the same process
const DEFAULT_STALE_SERVER_MS = 30_000;
const PRUNE_INTERVAL_MS = 10_000;
/**
 * An in-memory driver.
 * good for local development, tests, and situationally onebox dev environments.
 * note that you must pass the same driver object to both the server and sdk in order for them to see each other's state.
 */
function createMemoryDriver(options = {}) {
    const staleServerMs = options.staleServerMs ?? DEFAULT_STALE_SERVER_MS;
    const rooms = new Map();
    const clients = new Map();
    const servers = new Map();
    const events = new EventEmitter();
    function getClientsForRoom(roomId) {
        const result = [];
        for (const c of clients.values()) {
            if (c.roomId === roomId) {
                result.push({
                    clientId: c.clientId,
                    status: c.status,
                    tags: c.tags,
                    connectedAt: c.connectedAt,
                });
            }
        }
        return result;
    }
    function roomToInfo(r) {
        return {
            roomId: r.roomId,
            roomType: r.roomType,
            serverId: r.serverId,
            status: r.status,
            endpoint: r.endpoint,
            clients: getClientsForRoom(r.roomId),
            data: { ...r.data },
            tags: { ...r.tags },
            createdAt: r.createdAt,
        };
    }
    function getRoomsForServer(serverId) {
        const result = [];
        for (const r of rooms.values()) {
            if (r.serverId === serverId)
                result.push(roomToInfo(r));
        }
        return result;
    }
    function serverToInfo(s) {
        return {
            serverId: s.serverId,
            endpoint: s.endpoint,
            lastHeartbeat: s.lastHeartbeat,
            rooms: getRoomsForServer(s.serverId),
            tags: { ...s.tags },
            roomTypes: [...s.roomTypes],
        };
    }
    function deleteClientsForRoom(roomId) {
        for (const [id, c] of clients) {
            if (c.roomId === roomId) {
                clients.delete(id);
            }
        }
    }
    // prune stale servers (and their rooms/clients) + expired client reservations
    function prune() {
        const now = Date.now();
        const staleCutoff = now - staleServerMs;
        // collect stale server ids
        const staleServerIds = [];
        for (const [id, s] of servers) {
            if (s.lastHeartbeat < staleCutoff) {
                staleServerIds.push(id);
            }
        }
        // delete stale servers and their rooms + clients
        for (const serverId of staleServerIds) {
            for (const [roomId, r] of rooms) {
                if (r.serverId === serverId) {
                    deleteClientsForRoom(roomId);
                    rooms.delete(roomId);
                }
            }
            servers.delete(serverId);
        }
        // prune expired client reservations (reserved but never connected)
        for (const [id, c] of clients) {
            if (c.status === 'reserved' && c.expiresAt > 0 && c.expiresAt < now) {
                clients.delete(id);
            }
        }
    }
    const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
    // don't hold the process open just for pruning
    pruneTimer.unref();
    async function registerRoom(roomId, roomType, serverId, data, tags) {
        if (!servers.has(serverId))
            throw new ServerNotFoundError(serverId);
        validateTags(tags);
        rooms.set(roomId, {
            roomId,
            roomType,
            serverId,
            status: 'requested',
            endpoint: null,
            roomSecret: null,
            data,
            tags: { ...tags },
            createdAt: Date.now(),
        });
        // notify the server immediately — no waiting for reconciler poll
        events.emit(`room-assigned:${serverId}`, { roomId, roomType, data });
    }
    async function unregisterRoom(roomId) {
        deleteClientsForRoom(roomId);
        rooms.delete(roomId);
    }
    async function roomReady(roomId, endpoint, roomSecret) {
        const r = rooms.get(roomId);
        if (r) {
            r.status = 'running';
            r.endpoint = endpoint;
            r.roomSecret = roomSecret;
            events.emit(`room-ready:${roomId}`, roomToInfo(r));
        }
    }
    async function roomFailure(roomId, reason) {
        // publish the failure BEFORE deleting so a waitForRoom waiter rejects
        // with the real cause rather than eventually timing out.
        events.emit(`room-failed:${roomId}`, reason);
        deleteClientsForRoom(roomId);
        rooms.delete(roomId);
    }
    async function waitForRoom(roomId, timeoutMs) {
        // check if already running
        const r = rooms.get(roomId);
        if (r && r.status === 'running')
            return roomToInfo(r);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                events.removeListener(`room-ready:${roomId}`, onReady);
                events.removeListener(`room-failed:${roomId}`, onFailed);
                reject(new RoomTimeoutError(roomId, timeoutMs));
            }, timeoutMs);
            function onReady(info) {
                clearTimeout(timer);
                events.removeListener(`room-failed:${roomId}`, onFailed);
                resolve(info);
            }
            function onFailed(reason) {
                clearTimeout(timer);
                events.removeListener(`room-ready:${roomId}`, onReady);
                reject(new RoomFailedError(roomId, reason));
            }
            events.once(`room-ready:${roomId}`, onReady);
            events.once(`room-failed:${roomId}`, onFailed);
        });
    }
    async function getRoomInfo(roomId) {
        const r = rooms.get(roomId);
        return r ? roomToInfo(r) : null;
    }
    async function listRooms(filter) {
        let result = Array.from(rooms.values());
        if (filter?.type) {
            result = result.filter((r) => r.roomType === filter.type);
        }
        if (filter?.status) {
            result = result.filter((r) => r.status === filter.status);
        }
        if (filter?.serverId) {
            result = result.filter((r) => r.serverId === filter.serverId);
        }
        if (filter?.tags?.eq) {
            for (const [k, v] of Object.entries(filter.tags.eq)) {
                result = result.filter((r) => r.tags[k] === v);
            }
        }
        if (filter?.tags?.neq) {
            for (const [k, v] of Object.entries(filter.tags.neq)) {
                result = result.filter((r) => r.tags[k] !== v);
            }
        }
        return result.map(roomToInfo);
    }
    async function addRoomTags(roomId, tags) {
        const r = rooms.get(roomId);
        if (!r)
            throw new RoomNotFoundError(roomId);
        validateTags(tags);
        Object.assign(r.tags, tags);
    }
    async function removeRoomTags(roomId, keys) {
        const r = rooms.get(roomId);
        if (!r)
            throw new RoomNotFoundError(roomId);
        for (const key of keys)
            delete r.tags[key];
    }
    async function reserveClient(roomId, ttl, data, tags) {
        const r = rooms.get(roomId);
        if (!r)
            throw new RoomNotFoundError(roomId);
        if (r.status !== 'running' || !r.roomSecret || !r.endpoint)
            throw new RoomNotRunningError(roomId);
        const clientTags = tags ?? {};
        validateTags(clientTags);
        validateReserveData(data);
        validateReserveTagsSize(clientTags);
        const clientId = crypto.randomUUID();
        const expiresAt = Date.now() + ttl;
        // mint jwt signed with the room's secret. tags travel as a separate
        // claim from user data so the room can forward them back over ipc.
        const token = await jwtSign({ clientId, roomId, exp: expiresAt, data: data ?? {}, tags: clientTags }, r.roomSecret);
        clients.set(clientId, {
            clientId,
            roomId,
            status: 'reserved',
            expiresAt,
            tags: clientTags,
            connectedAt: 0,
        });
        // build full websocket url with token baked in as query param
        const url = new URL(r.endpoint);
        url.searchParams.set('token', token);
        return { clientId, url: url.toString(), roomId, expiresAt };
    }
    async function connectClient(clientId, roomId, tags) {
        // upsert: write every field reserveClient writes, mirroring the redis
        // driver's MULTI semantics. memory isn't subject to TTL eviction so the
        // record will normally exist, but we treat the ipc payload as the
        // authoritative source either way for cross-driver behavioural parity.
        clients.set(clientId, {
            clientId,
            roomId,
            status: 'connected',
            expiresAt: 0,
            tags,
            connectedAt: Date.now(),
        });
    }
    async function disconnectClient(clientId) {
        clients.delete(clientId);
    }
    // heartbeat doubles as registration: the first call inserts a new record with
    // the supplied tags; subsequent calls refresh lastHeartbeat and update
    // endpoint/roomTypes, but leave tags untouched (see addServerTags/removeServerTags).
    // returns the current authoritative tag state and rooms assigned to this server
    // so the caller can reconcile in the same round-trip.
    async function heartbeat(options) {
        const existing = servers.get(options.serverId);
        const registered = !existing;
        if (existing) {
            existing.lastHeartbeat = Date.now();
            existing.endpoint = options.endpoint;
            existing.roomTypes = [...options.roomTypes];
        }
        else {
            validateTags(options.tags);
            // evict previous servers on the same endpoint (handles restarts)
            for (const [id, s] of servers) {
                if (s.endpoint === options.endpoint) {
                    for (const [roomId, r] of rooms) {
                        if (r.serverId === id) {
                            deleteClientsForRoom(roomId);
                            rooms.delete(roomId);
                        }
                    }
                    servers.delete(id);
                }
            }
            servers.set(options.serverId, {
                serverId: options.serverId,
                endpoint: options.endpoint,
                tags: { ...options.tags },
                roomTypes: [...options.roomTypes],
                lastHeartbeat: Date.now(),
            });
        }
        // record always exists at this point — either it already did, or we just inserted it.
        // biome-ignore lint/style/noNonNullAssertion: invariant from the branch above
        const current = servers.get(options.serverId);
        const desiredRooms = [];
        for (const r of rooms.values()) {
            if (r.serverId === options.serverId) {
                desiredRooms.push({ roomId: r.roomId, roomType: r.roomType, data: r.data });
            }
        }
        return { tags: { ...current.tags }, desiredRooms, registered };
    }
    async function unregisterServer(serverId) {
        // delete all rooms for this server
        for (const [roomId, r] of rooms) {
            if (r.serverId === serverId) {
                deleteClientsForRoom(roomId);
                rooms.delete(roomId);
            }
        }
        servers.delete(serverId);
    }
    async function addServerTags(serverId, tags) {
        const s = servers.get(serverId);
        if (!s)
            throw new ServerNotFoundError(serverId);
        validateTags(tags);
        Object.assign(s.tags, tags);
    }
    async function removeServerTags(serverId, keys) {
        const s = servers.get(serverId);
        if (!s)
            throw new ServerNotFoundError(serverId);
        for (const key of keys)
            delete s.tags[key];
    }
    async function listServers(filter) {
        const cutoff = Date.now() - staleServerMs;
        let result = Array.from(servers.values()).filter((s) => s.lastHeartbeat >= cutoff);
        if (filter?.roomTypes) {
            const required = filter.roomTypes;
            result = result.filter((s) => required.every((rt) => s.roomTypes.includes(rt)));
        }
        if (filter?.tags?.eq) {
            for (const [k, v] of Object.entries(filter.tags.eq)) {
                result = result.filter((s) => s.tags[k] === v);
            }
        }
        if (filter?.tags?.neq) {
            for (const [k, v] of Object.entries(filter.tags.neq)) {
                result = result.filter((s) => s.tags[k] !== v);
            }
        }
        return result.map(serverToInfo);
    }
    async function listStaleServers() {
        const cutoff = Date.now() - staleServerMs;
        const result = [];
        for (const s of servers.values()) {
            if (s.lastHeartbeat < cutoff)
                result.push(serverToInfo(s));
        }
        return result;
    }
    async function getServer(serverId) {
        const s = servers.get(serverId);
        return s ? serverToInfo(s) : null;
    }
    async function subscribeRoomAssignments(serverId, callback) {
        const listener = (room) => callback(room);
        events.on(`room-assigned:${serverId}`, listener);
        return () => {
            events.removeListener(`room-assigned:${serverId}`, listener);
        };
    }
    async function tryAcquireLeader() {
        return true;
    }
    async function renewLeader() {
        return true;
    }
    async function releaseLeader() { }
    return {
        destroy() {
            clearInterval(pruneTimer);
        },
        _internal: {
            local: true,
            registerRoom,
            unregisterRoom,
            roomReady,
            roomFailure,
            waitForRoom,
            getRoomInfo,
            listRooms,
            addRoomTags,
            removeRoomTags,
            reserveClient,
            connectClient,
            disconnectClient,
            heartbeat,
            unregisterServer,
            addServerTags,
            removeServerTags,
            listServers,
            listStaleServers,
            getServer,
            subscribeRoomAssignments,
            tryAcquireLeader,
            renewLeader,
            releaseLeader,
        },
    };
}

export { DriverConfigError, GathoError, InvalidTagError, PayloadTooLargeError, RESERVE_DATA_MAX_BYTES, RESERVE_TAGS_MAX_BYTES, RoomFailedError, RoomNotFoundError, RoomNotRunningError, RoomStartError, RoomTimeoutError, ServerNotFoundError, createMemoryDriver, validateReserveData, validateReserveTagsSize, validateTags };
//# sourceMappingURL=driver.js.map
