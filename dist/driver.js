import { EventEmitter } from 'node:events';
import Redis from 'ioredis';

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
const STALE_MS$1 = 30_000;
const PRUNE_INTERVAL_MS = 10_000;
/**
 * An in-memory driver.
 * good for local development, tests, and situationally onebox dev environments.
 * note that you must pass the same driver object to both the server and sdk in order for them to see each other's state.
 */
function createMemoryDriver() {
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
            data: r.data,
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
        const staleCutoff = now - STALE_MS$1;
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
    async function roomFailure(roomId, _reason) {
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
                reject(new RoomTimeoutError(roomId, timeoutMs));
            }, timeoutMs);
            function onReady(info) {
                clearTimeout(timer);
                resolve(info);
            }
            events.once(`room-ready:${roomId}`, onReady);
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
        const cutoff = Date.now() - STALE_MS$1;
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
        const cutoff = Date.now() - STALE_MS$1;
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

// structured json line logger
// emits ndjson to stdout/stderr, supports child loggers for scoped context
const LEVEL_VALUES = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
function resolveLevel() {
    const env = (typeof process !== 'undefined' && process.env?.GATHO_LOG_LEVEL) || '';
    const lower = env.toLowerCase();
    if (lower in LEVEL_VALUES)
        return lower;
    return 'info';
}
// serialize a value, handling Error instances that JSON.stringify turns into {}
function serializeValue(value) {
    if (value instanceof Error) {
        return { message: value.message, stack: value.stack };
    }
    return value;
}
function buildLine(level, msg, context, fields) {
    const entry = { ts: Date.now(), level, msg };
    for (const key in context) {
        entry[key] = serializeValue(context[key]);
    }
    if (fields) {
        for (const key in fields) {
            entry[key] = serializeValue(fields[key]);
        }
    }
    return JSON.stringify(entry);
}
function createLoggerInternal(minLevel, context) {
    function log(level, msg, fields) {
        if (LEVEL_VALUES[level] < minLevel)
            return;
        const line = buildLine(level, msg, context, fields);
        if (level === 'error') {
            process.stderr.write(`${line}\n`);
        }
        else {
            process.stdout.write(`${line}\n`);
        }
    }
    return {
        debug: (msg, fields) => log('debug', msg, fields),
        info: (msg, fields) => log('info', msg, fields),
        warn: (msg, fields) => log('warn', msg, fields),
        error: (msg, fields) => log('error', msg, fields),
        child(fields) {
            return createLoggerInternal(minLevel, { ...context, ...fields });
        },
    };
}
function createLogger(options) {
    const level = resolveLevel();
    return createLoggerInternal(LEVEL_VALUES[level], {});
}
// module-scope singleton — reads GATHO_LOG_LEVEL at import time
const log = createLogger();

function attachLifecycleLogging(c, name) {
    c.on('error', (err) => log.error('redis connection error', { connection: name, err }));
    c.on('end', () => log.warn('redis connection ended', { connection: name }));
    c.on('reconnecting', (ms) => log.warn('redis reconnecting', { connection: name, delayMs: ms }));
    c.on('ready', () => log.info('redis ready', { connection: name }));
}
/**
 * redis driver implementation using ioredis
 * multi-server production driver backed by redis
 * works with standalone redis, sentinel, and redis cluster.
 * leverages native key expiry for reservations, set indexes for fast lookups
 */
function createRedisDriver(options = {}) {
    const prefix = options.prefix ?? 'gatho:{gatho}:';
    const keys = createKeys(prefix);
    const client = options.client ?? new Redis(options.url ?? process.env.GATHO_REDIS_URL ?? 'redis://localhost:6379');
    // surface connection lifecycle so transient outages are observable.
    // ioredis swallows 'error' events into its own handler — without this we
    // have zero signal when the underlying socket flaps.
    attachLifecycleLogging(client, 'main');
    // shared subscriber connection — lazily created on first waitForRoom call.
    // ioredis requires a dedicated connection for subscriptions (subscribed
    // clients can't issue normal commands). instead of creating one per call,
    // we share a single connection and multiplex channels via a listener map.
    let subscriber = null;
    const channelListeners = new Map();
    function getSubscriber() {
        if (!subscriber) {
            subscriber = client.duplicate();
            attachLifecycleLogging(subscriber, 'subscriber');
            subscriber.on('message', (ch, msg) => {
                const listeners = channelListeners.get(ch);
                if (!listeners)
                    return;
                for (const listener of listeners) {
                    listener(ch, msg);
                }
            });
        }
        return subscriber;
    }
    // subscribe a listener to a channel. returns an unsubscribe function.
    // first listener for a channel subscribes, last removal unsubscribes.
    async function subscribeChannel(channel, listener) {
        const sub = getSubscriber();
        let listeners = channelListeners.get(channel);
        const isNew = !listeners || listeners.size === 0;
        if (!listeners) {
            listeners = new Set();
            channelListeners.set(channel, listeners);
        }
        listeners.add(listener);
        if (isNew) {
            await sub.subscribe(channel);
        }
        let removed = false;
        return () => {
            if (removed)
                return;
            removed = true;
            const set = channelListeners.get(channel);
            if (set) {
                set.delete(listener);
                if (set.size === 0) {
                    channelListeners.delete(channel);
                    sub.unsubscribe(channel).catch(() => { });
                }
            }
        };
    }
    // flush all keys with our prefix if the stored schema version doesn't
    // match. uses SCAN to avoid blocking redis on large keyspaces, and
    // UNLINK (async DEL) per-key for redis cluster compatibility.
    async function ensureSchemaVersion() {
        const stored = await client.get(keys.schemaVersion);
        if (stored === String(SCHEMA_VERSION))
            return;
        // mismatch or missing — wipe everything under our prefix
        let cursor = '0';
        do {
            const [next, batch] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
            cursor = next;
            for (const key of batch) {
                await client.unlink(key);
            }
        } while (cursor !== '0');
        await client.set(keys.schemaVersion, String(SCHEMA_VERSION));
    }
    // helper: get client info for all clients in a room
    async function getClientsForRoom(roomId) {
        const clientIds = await client.smembers(keys.clientsByRoom(roomId));
        const result = [];
        for (const clientId of clientIds) {
            const clientData = await client.hgetall(keys.client(clientId));
            if (clientData.clientId) {
                result.push({
                    clientId: clientData.clientId,
                    status: clientData.status,
                    tags: clientData.tags ? JSON.parse(clientData.tags) : {},
                    connectedAt: clientData.connectedAt ? Number(clientData.connectedAt) : 0,
                });
            }
            else {
                // stale index entry — client key expired/deleted
                await client.srem(keys.clientsByRoom(roomId), clientId);
            }
        }
        return result;
    }
    // helper: build RoomInfo from redis hash data
    async function hashToRoomInfo(data) {
        if (!data || !data.roomId)
            return null;
        const clients = await getClientsForRoom(data.roomId);
        return {
            roomId: data.roomId,
            roomType: data.roomType,
            serverId: data.serverId,
            status: (data.status || 'requested'),
            endpoint: data.endpoint || null,
            clients,
            data: JSON.parse(data.data || '{}'),
            tags: JSON.parse(data.tags || '{}'),
            createdAt: Number(data.createdAt),
        };
    }
    // helper: get all rooms for a server
    async function getRoomsForServer(serverId) {
        const roomIds = await client.smembers(keys.roomsByServerId(serverId));
        if (roomIds.length === 0)
            return [];
        const rooms = await Promise.all(roomIds.map(async (roomId) => {
            const data = await client.hgetall(keys.room(roomId));
            if (!data || !data.roomId) {
                // stale index entry
                await client.srem(keys.roomsByServerId(serverId), roomId);
                return null;
            }
            return hashToRoomInfo(data);
        }));
        return rooms.filter((r) => r !== null);
    }
    // helper: build ServerInfo from redis hash data
    async function hashToServerInfo(data) {
        if (!data || !data.serverId)
            return null;
        return {
            serverId: data.serverId,
            endpoint: data.endpoint,
            lastHeartbeat: Number(data.lastHeartbeat),
            rooms: await getRoomsForServer(data.serverId),
            tags: JSON.parse(data.tags || '{}'),
            roomTypes: JSON.parse(data.roomTypes || '[]'),
        };
    }
    async function registerRoom(roomId, roomType, serverId, data, tags) {
        validateTags(tags);
        // verify server exists
        const serverData = await client.hgetall(keys.server(serverId));
        if (!serverData || !serverData.endpoint) {
            throw new ServerNotFoundError(serverId);
        }
        const key = keys.room(roomId);
        const now = Date.now();
        await client.hset(key, {
            roomId,
            roomType,
            serverId,
            status: 'requested',
            data: JSON.stringify(data),
            tags: JSON.stringify(tags),
            createdAt: String(now),
        });
        // auto-expire the room hash if the worker never becomes ready
        await client.pexpire(key, REQUESTED_ROOM_TTL_MS);
        await client.sadd(keys.rooms, roomId);
        await client.sadd(keys.roomsByServerId(serverId), roomId);
        // notify the server immediately — no waiting for reconciler poll
        await client.publish(keys.roomAssigned(serverId), JSON.stringify({ roomId, roomType, data }));
    }
    async function unregisterRoom(roomId) {
        const data = await client.hgetall(keys.room(roomId));
        if (data.serverId) {
            await client.srem(keys.roomsByServerId(data.serverId), roomId);
        }
        // clean up all clients for this room
        const clientIds = await client.smembers(keys.clientsByRoom(roomId));
        for (const clientId of clientIds) {
            await client.del(keys.client(clientId));
        }
        await client.del(keys.clientsByRoom(roomId));
        await client.del(keys.room(roomId));
        await client.srem(keys.rooms, roomId);
    }
    async function roomReady(roomId, endpoint, roomSecret) {
        await client.hset(keys.room(roomId), {
            status: 'running',
            endpoint,
            roomSecret,
        });
        // remove ttl — running rooms persist until explicitly unregistered
        await client.persist(keys.room(roomId));
        // notify waiters via pub/sub
        await client.publish(keys.roomReady(roomId), roomId);
    }
    async function roomFailure(roomId, _reason) {
        await unregisterRoom(roomId);
    }
    async function waitForRoom(roomId, timeoutMs) {
        // check if already running before subscribing
        const existing = await getRoomInfo(roomId);
        if (existing && existing.status === 'running')
            return existing;
        const channel = keys.roomReady(roomId);
        return new Promise((resolve, reject) => {
            let settled = false;
            let unsub = null;
            const cleanup = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (unsub)
                    unsub();
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new RoomTimeoutError(roomId, timeoutMs));
            }, timeoutMs);
            const listener = (_ch, _msg) => {
                cleanup();
                // fetch full room info
                getRoomInfo(roomId)
                    .then((info) => {
                    if (info) {
                        resolve(info);
                    }
                    else {
                        reject(new RoomStartError(roomId));
                    }
                })
                    .catch(reject);
            };
            subscribeChannel(channel, listener)
                .then((unsubFn) => {
                unsub = unsubFn;
                // if we settled while awaiting subscribe (timeout fired), clean up
                if (settled) {
                    unsubFn();
                    return;
                }
                // re-check after subscribing — the room might have become
                // ready between our initial check and the subscribe completing
                getRoomInfo(roomId)
                    .then((info) => {
                    if (info && info.status === 'running' && !settled) {
                        cleanup();
                        resolve(info);
                    }
                })
                    .catch(() => { });
            })
                .catch((err) => {
                cleanup();
                reject(err);
            });
        });
    }
    async function getRoomInfo(roomId) {
        const data = await client.hgetall(keys.room(roomId));
        return hashToRoomInfo(data);
    }
    async function listRooms(filter) {
        const roomIds = await client.smembers(keys.rooms);
        if (roomIds.length === 0)
            return [];
        const rooms = await Promise.all(roomIds.map((roomId) => getRoomInfo(roomId)));
        let result = rooms.filter((r) => r !== null);
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
        return result;
    }
    async function addRoomTags(roomId, tags) {
        validateTags(tags);
        const data = await client.hgetall(keys.room(roomId));
        if (!data || !data.roomId)
            throw new RoomNotFoundError(roomId);
        const existing = JSON.parse(data.tags || '{}');
        const merged = { ...existing, ...tags };
        await client.hset(keys.room(roomId), { tags: JSON.stringify(merged) });
    }
    async function removeRoomTags(roomId, tagKeys) {
        const data = await client.hgetall(keys.room(roomId));
        if (!data || !data.roomId)
            throw new RoomNotFoundError(roomId);
        const existing = JSON.parse(data.tags || '{}');
        for (const key of tagKeys) {
            delete existing[key];
        }
        await client.hset(keys.room(roomId), { tags: JSON.stringify(existing) });
    }
    async function reserveClient(roomId, ttl, data, tags) {
        // look up room to get endpoint and roomSecret for jwt minting
        const roomData = await client.hgetall(keys.room(roomId));
        if (!roomData || !roomData.roomId) {
            throw new RoomNotFoundError(roomId);
        }
        if (roomData.status !== 'running' || !roomData.roomSecret || !roomData.endpoint) {
            throw new RoomNotRunningError(roomId);
        }
        const clientTags = tags ?? {};
        validateTags(clientTags);
        validateReserveData(data);
        validateReserveTagsSize(clientTags);
        const clientId = crypto.randomUUID();
        const expiresAt = Date.now() + ttl;
        // mint jwt signed with the room's secret — room verifies locally, zero ipc.
        // tags travel as a separate claim from user data: rooms are untrusted and
        // must forward tags back over ipc so connectClient can reconstitute the
        // hash if redis evicted it during the reserve→connect window.
        const token = await jwtSign({ clientId, roomId, exp: expiresAt, data: data ?? {}, tags: clientTags }, roomData.roomSecret);
        // store client record
        await client.hset(keys.client(clientId), {
            clientId,
            roomId,
            status: 'reserved',
            expiresAt: String(expiresAt),
            tags: JSON.stringify(clientTags),
            connectedAt: '0',
        });
        // set TTL on the client key — auto-expires if never connected
        await client.pexpire(keys.client(clientId), ttl);
        // add to room's client set
        await client.sadd(keys.clientsByRoom(roomId), clientId);
        return {
            clientId,
            url: (() => {
                const u = new URL(roomData.endpoint);
                u.searchParams.set('token', token);
                return u.toString();
            })(),
            roomId,
            expiresAt,
        };
    }
    async function connectClient(clientId, roomId, tags) {
        // atomic upsert: write every field reserveClient writes, persist the key,
        // and ensure the room's client set contains us. self-healing — if the
        // hash was evicted (TTL fired during the reserve→connect ipc window) or
        // partially mutated, this restores it from authoritative state forwarded
        // by the room over ipc. MULTI gives single-round-trip atomicity without
        // the EVAL/EVALSHA script-cache overhead — we have no read-conditional
        // logic, just a fixed sequence of writes.
        await client
            .multi()
            .hset(keys.client(clientId), {
            clientId,
            roomId,
            status: 'connected',
            expiresAt: '0',
            tags: JSON.stringify(tags),
            connectedAt: String(Date.now()),
        })
            .persist(keys.client(clientId))
            .sadd(keys.clientsByRoom(roomId), clientId)
            .exec();
    }
    async function disconnectClient(clientId) {
        const clientData = await client.hgetall(keys.client(clientId));
        if (clientData.roomId) {
            await client.srem(keys.clientsByRoom(clientData.roomId), clientId);
        }
        await client.del(keys.client(clientId));
    }
    // heartbeat doubles as registration. on first call the server hash doesn't
    // exist, so we validate tags, evict any prior server on the same endpoint
    // (restart case), and write the full record. on subsequent calls we just
    // refresh lastHeartbeat plus endpoint/roomTypes — `tags` is HSETNX'd so
    // mutations from addServerTags/removeServerTags survive intact.
    // returns the authoritative tag state (post-write) and the rooms currently
    // assigned to this server, so the caller's control loop can reconcile in
    // the same round-trip.
    let schemaVersionEnsured = false;
    async function heartbeat(options) {
        if (!schemaVersionEnsured) {
            await ensureSchemaVersion();
            schemaVersionEnsured = true;
        }
        const key = keys.server(options.serverId);
        const exists = (await client.exists(key)) === 1;
        const registered = !exists;
        if (!exists) {
            validateTags(options.tags);
            // evict any previous server registered on the same endpoint —
            // handles restarts where the new process picks a fresh serverId
            const serverIds = await client.smembers(keys.servers);
            for (const id of serverIds) {
                if (id === options.serverId)
                    continue;
                const ep = await client.hget(keys.server(id), 'endpoint');
                if (ep === options.endpoint) {
                    await unregisterServer(id);
                }
            }
        }
        const tx = client.multi();
        // first-insert-only tags — preserves later add/removeServerTags writes
        tx.hsetnx(key, 'tags', JSON.stringify(options.tags));
        tx.hset(key, {
            serverId: options.serverId,
            endpoint: options.endpoint,
            roomTypes: JSON.stringify(options.roomTypes),
            lastHeartbeat: String(Date.now()),
        });
        tx.sadd(keys.servers, options.serverId);
        // last command in the transaction reads the post-write tags so the
        // caller can refresh its in-memory cache without a second round-trip.
        tx.hget(key, 'tags');
        const txResults = await tx.exec();
        // tx.exec() returns null only if the transaction was discarded (e.g.,
        // WATCH conflict — we don't use WATCH, so this should not happen).
        const tagsRaw = (txResults?.[3]?.[1] ?? null);
        const tags = tagsRaw ? JSON.parse(tagsRaw) : {};
        // collect desired rooms in the same call. paying for the second
        // round-trip here vs on a separate reconcile tick — net halves the
        // control-plane round-trip count.
        const roomIds = await client.smembers(keys.roomsByServerId(options.serverId));
        const desiredRooms = [];
        if (roomIds.length > 0) {
            const rooms = await Promise.all(roomIds.map(async (roomId) => {
                const data = await client.hgetall(keys.room(roomId));
                if (!data || !data.roomId) {
                    // stale index entry
                    await client.srem(keys.roomsByServerId(options.serverId), roomId);
                    return null;
                }
                return {
                    roomId: data.roomId,
                    roomType: data.roomType,
                    data: JSON.parse(data.data || '{}'),
                };
            }));
            for (const r of rooms)
                if (r)
                    desiredRooms.push(r);
        }
        return { tags, desiredRooms, registered };
    }
    async function unregisterServer(serverId) {
        // clean up all rooms owned by this server
        const roomIds = await client.smembers(keys.roomsByServerId(serverId));
        for (const roomId of roomIds) {
            await unregisterRoom(roomId);
        }
        await client.del(keys.roomsByServerId(serverId));
        await client.del(keys.server(serverId));
        await client.srem(keys.servers, serverId);
    }
    async function addServerTags(serverId, tags) {
        validateTags(tags);
        const data = await client.hgetall(keys.server(serverId));
        if (!data || !data.serverId)
            throw new ServerNotFoundError(serverId);
        const existing = JSON.parse(data.tags || '{}');
        const merged = { ...existing, ...tags };
        await client.hset(keys.server(serverId), { tags: JSON.stringify(merged) });
    }
    async function removeServerTags(serverId, tagKeys) {
        const data = await client.hgetall(keys.server(serverId));
        if (!data || !data.serverId)
            throw new ServerNotFoundError(serverId);
        const existing = JSON.parse(data.tags || '{}');
        for (const key of tagKeys) {
            delete existing[key];
        }
        await client.hset(keys.server(serverId), { tags: JSON.stringify(existing) });
    }
    async function listServers(filter) {
        const cutoff = Date.now() - STALE_MS;
        const serverIds = await client.smembers(keys.servers);
        if (serverIds.length === 0)
            return [];
        const servers = await Promise.all(serverIds.map(async (serverId) => {
            const data = await client.hgetall(keys.server(serverId));
            if (!data || !data.serverId) {
                await client.srem(keys.servers, serverId);
                return null;
            }
            const lastHeartbeat = Number(data.lastHeartbeat);
            if (lastHeartbeat < cutoff)
                return null;
            return hashToServerInfo(data);
        }));
        let result = servers.filter((s) => s !== null);
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
        return result;
    }
    async function listStaleServers() {
        const cutoff = Date.now() - STALE_MS;
        const serverIds = await client.smembers(keys.servers);
        if (serverIds.length === 0)
            return [];
        const servers = await Promise.all(serverIds.map(async (serverId) => {
            const data = await client.hgetall(keys.server(serverId));
            if (!data || !data.serverId) {
                await client.srem(keys.servers, serverId);
                return null;
            }
            const lastHeartbeat = Number(data.lastHeartbeat);
            // only include servers whose heartbeat IS older than cutoff
            if (lastHeartbeat >= cutoff)
                return null;
            return hashToServerInfo(data);
        }));
        return servers.filter((s) => s !== null);
    }
    async function getServer(serverId) {
        const data = await client.hgetall(keys.server(serverId));
        return hashToServerInfo(data);
    }
    async function subscribeRoomAssignments(serverId, callback) {
        const channel = keys.roomAssigned(serverId);
        const listener = (_ch, msg) => {
            let parsed;
            try {
                parsed = JSON.parse(msg);
            }
            catch {
                console.error('[gatho] malformed room-assigned message, discarding', { channel, msg });
                return;
            }
            callback(parsed);
        };
        return subscribeChannel(channel, listener);
    }
    async function tryAcquireLeader(serverId) {
        // SET NX PX — atomic acquire, only succeeds if key doesn't exist
        const result = await client.set(keys.leader, serverId, 'PX', LEADER_LOCK_TTL_MS, 'NX');
        return result === 'OK';
    }
    async function renewLeader(serverId) {
        // compare-and-swap: only extend if we still own the lock
        const result = await client.eval(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end`, 1, keys.leader, serverId, String(LEADER_LOCK_TTL_MS));
        return result === 1;
    }
    async function releaseLeader(serverId) {
        // compare-and-swap: only delete if we still own the lock
        await client.eval(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`, 1, keys.leader, serverId);
    }
    return {
        _internal: {
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
// hardcoded staleness threshold — servers older than this are considered dead
const STALE_MS = 30_000;
// how long a 'requested' room hash lives before redis auto-expires it
const REQUESTED_ROOM_TTL_MS = 30_000;
// leader lock ttl — generous enough to survive transient redis hiccups
const LEADER_LOCK_TTL_MS = 30_000;
// bump this when the redis schema changes. on mismatch, all prefixed keys
// are flushed — servers and rooms are ephemeral, no migration needed.
const SCHEMA_VERSION = 2;
// key helpers - keep all redis key construction in one place
function createKeys(prefix) {
    return {
        // room hash: stores roomId, roomType, serverId, createdAt, data, tags, endpoint, roomSecret
        room: (roomId) => `${prefix}room:${roomId}`,
        // set of all room ids
        rooms: `${prefix}rooms`,
        // set of room ids by server id
        roomsByServerId: (serverId) => `${prefix}rooms:server:${serverId}`,
        // client hash: stores clientId, roomId, status, expiresAt
        client: (clientId) => `${prefix}client:${clientId}`,
        // set of client ids by room id
        clientsByRoom: (roomId) => `${prefix}clients:room:${roomId}`,
        // server hash: stores serverId, endpoint, lastHeartbeat, tags, roomTypes
        server: (serverId) => `${prefix}server:${serverId}`,
        // set of all server ids
        servers: `${prefix}servers`,
        // leader election lock
        leader: `${prefix}leader`,
        // pub/sub channel for room-ready notifications
        roomReady: (roomId) => `${prefix}room-ready:${roomId}`,
        // pub/sub channel for room assignment notifications (per-server)
        roomAssigned: (serverId) => `${prefix}room-assigned:${serverId}`,
        // schema version — checked on server registration
        schemaVersion: `${prefix}schema_version`,
    };
}

export { DriverConfigError, GathoError, InvalidTagError, PayloadTooLargeError, RESERVE_DATA_MAX_BYTES, RESERVE_TAGS_MAX_BYTES, RoomNotFoundError, RoomNotRunningError, RoomStartError, RoomTimeoutError, ServerNotFoundError, createMemoryDriver, createRedisDriver };
//# sourceMappingURL=driver.js.map
