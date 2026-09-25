import Redis from 'ioredis';
import { ServerNotFoundError, validateTags, RoomNotFoundError, RoomNotRunningError, validateReserveData, validateReserveTagsSize, waitForRoomRunning, validateRequestedRoomTtl } from 'gatho/driver';

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

/** how often a canary token is published */
const CANARY_INTERVAL_MS = 5_000;
/** how long after its PUBLISH resolves a token may go unreceived */
const CANARY_TIMEOUT_MS = 10_000;
/** how often tick() must be called */
const CANARY_CHECK_MS = 1_000;
/**
 * proves a subscriber still receives by publishing tokens to a channel it listens on.
 * a token counts as missed only once its PUBLISH has resolved, so a slow or dead
 * publishing connection is never blamed on the subscriber.
 */
function createSubscriberCanary(publish, isReady, reconnect, now) {
    let sequence = 0;
    let lastSentAt = Number.NEGATIVE_INFINITY;
    // publishedAt is null until the PUBLISH resolves
    let outstanding = null;
    return {
        received(token) {
            if (outstanding?.token === token)
                outstanding = null;
        },
        tick() {
            if (!isReady()) {
                outstanding = null;
                return;
            }
            const at = now();
            if (outstanding) {
                const { publishedAt } = outstanding;
                if (publishedAt !== null && at - publishedAt > CANARY_TIMEOUT_MS) {
                    outstanding = null;
                    reconnect(at - publishedAt);
                }
                return;
            }
            if (at - lastSentAt < CANARY_INTERVAL_MS)
                return;
            lastSentAt = at;
            const canary = { token: String(++sequence), publishedAt: null };
            outstanding = canary;
            publish(canary.token).then(() => {
                canary.publishedAt = now();
            }, () => {
                // the publishing connection's trouble, not the subscriber's
                if (outstanding === canary)
                    outstanding = null;
            });
        },
    };
}

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
    // staleness threshold — servers whose last heartbeat is older than this are
    // considered dead (dropped from listServers, reaped by listStaleServers).
    const staleServerMs = options.staleServerMs ?? DEFAULT_STALE_SERVER_MS;
    const client = options.client ?? new Redis(options.url ?? process.env.GATHO_REDIS_URL ?? 'redis://localhost:6379');
    // surface connection lifecycle so transient outages are observable.
    // ioredis swallows 'error' events into its own handler — without this we
    // have zero signal when the underlying socket flaps.
    attachLifecycleLogging(client, 'main');
    // shared subscriber connection, lazily created on first use.
    // ioredis requires a dedicated connection for subscriptions (subscribed
    // clients can't issue normal commands). instead of creating one per call,
    // we share a single connection and multiplex channels via a listener map.
    let subscriber = null;
    const channelListeners = new Map();
    // in-flight SUBSCRIBE per channel, so concurrent subscribers share its outcome
    const pendingSubscribes = new Map();
    // a subscriber never writes, so only its own keepalive probe can discover a peer that dropped it
    function duplicateForSubscriber() {
        if (client instanceof Redis)
            return client.duplicate({ keepAlive: SUBSCRIBER_KEEPALIVE_MS });
        return client.duplicate([], { redisOptions: { keepAlive: SUBSCRIBER_KEEPALIVE_MS } });
    }
    function getSubscriber() {
        if (subscriber)
            return subscriber;
        const sub = duplicateForSubscriber();
        subscriber = sub;
        attachLifecycleLogging(sub, 'subscriber');
        sub.on('message', (ch, msg) => {
            const listeners = channelListeners.get(ch);
            if (!listeners)
                return;
            for (const listener of listeners) {
                listener(ch, msg);
            }
        });
        // ioredis restores only subscriptions it saw succeed; re-issue the intended set on every ready
        sub.on('ready', () => {
            const channels = Array.from(channelListeners.keys());
            if (channels.length === 0)
                return;
            sub.subscribe(...channels).catch((err) => {
                log.warn('redis resubscribe failed', { channels: channels.length, err });
            });
        });
        startCanary(sub);
        return sub;
    }
    // subscribe a listener to a channel. returns an unsubscribe function.
    // first listener subscribes, last removal unsubscribes; a failed SUBSCRIBE rolls back every waiter
    async function subscribeChannel(channel, listener) {
        const sub = getSubscriber();
        let listeners = channelListeners.get(channel);
        if (!listeners) {
            listeners = new Set();
            channelListeners.set(channel, listeners);
        }
        const isNew = listeners.size === 0;
        listeners.add(listener);
        const removeListener = () => {
            const set = channelListeners.get(channel);
            if (!set)
                return;
            set.delete(listener);
            if (set.size === 0) {
                channelListeners.delete(channel);
                sub.unsubscribe(channel).catch((err) => {
                    log.warn('redis unsubscribe failed', { channel, err });
                });
            }
        };
        let pending = pendingSubscribes.get(channel);
        if (isNew) {
            const subscribing = sub.subscribe(channel).then(() => undefined);
            pending = subscribing;
            pendingSubscribes.set(channel, subscribing);
            // registered before any waiter's continuation, so the entry is gone before a waiter can leave the set
            const forget = () => pendingSubscribes.delete(channel);
            subscribing.then(forget, forget);
        }
        if (pending) {
            try {
                await pending;
            }
            catch (err) {
                removeListener();
                throw err;
            }
        }
        let removed = false;
        return () => {
            if (removed)
                return;
            removed = true;
            removeListener();
        };
    }
    // the subscriber proves itself by receiving a token we publish: socket, subscription and routing at once
    const canaryChannel = keys.canary(crypto.randomUUID());
    let canaryTimer = null;
    function startCanary(sub) {
        const canary = createSubscriberCanary((token) => client.publish(canaryChannel, token), () => sub.status === 'ready', (missedMs) => {
            log.warn('subscriber canary missed, reconnecting', { missedMs });
            sub.disconnect(true);
        }, Date.now);
        // permanently in the intended set, so the ready handler re-subscribes it after any failure
        channelListeners.set(canaryChannel, new Set([(_ch, token) => canary.received(token)]));
        canaryTimer = setInterval(() => canary.tick(), CANARY_CHECK_MS);
        canaryTimer.unref();
    }
    // redis's clock: every staleness judgement uses one clock, whichever host asks
    async function redisNowMs() {
        const [seconds, micros] = await client.time();
        return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
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
    // helper: get client info for all clients in a room.
    // one smembers to read the index, then a single pipeline of hgetalls — one
    // round-trip for the whole fan-out instead of N sequential reads. stale index
    // entries (client key expired/deleted between the smembers and the read) are
    // collected from the pipeline results and srem'd afterwards, preserving the
    // self-cleanup the sequential version did inline.
    async function getClientsForRoom(roomId) {
        const clientIds = await client.smembers(keys.clientsByRoom(roomId));
        if (clientIds.length === 0)
            return [];
        const pipeline = client.pipeline();
        for (const clientId of clientIds) {
            pipeline.hgetall(keys.client(clientId));
        }
        const results = await pipeline.exec();
        const result = [];
        const stale = [];
        for (let i = 0; i < clientIds.length; i++) {
            const clientData = (results?.[i]?.[1] ?? {});
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
                stale.push(clientIds[i]);
            }
        }
        if (stale.length > 0) {
            await client.srem(keys.clientsByRoom(roomId), ...stale);
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
    // batch-read room hashes for a set of ids in a single pipeline. returns the
    // live room hashes (in the same order) and collects stale index ids so the
    // caller can srem them from whatever index they came from.
    async function readRoomHashes(roomIds) {
        const pipeline = client.pipeline();
        for (const roomId of roomIds) {
            pipeline.hgetall(keys.room(roomId));
        }
        const results = await pipeline.exec();
        const hashes = [];
        const stale = [];
        for (let i = 0; i < roomIds.length; i++) {
            const data = (results?.[i]?.[1] ?? {});
            if (data.roomId) {
                hashes.push(data);
            }
            else {
                stale.push(roomIds[i]);
            }
        }
        return { hashes, stale };
    }
    // helper: get all rooms for a server. one smembers + one pipeline of room
    // hgetalls, then hashToRoomInfo fans out per-room client reads.
    async function getRoomsForServer(serverId) {
        const roomIds = await client.smembers(keys.roomsByServerId(serverId));
        if (roomIds.length === 0)
            return [];
        const { hashes, stale } = await readRoomHashes(roomIds);
        if (stale.length > 0) {
            await client.srem(keys.roomsByServerId(serverId), ...stale);
        }
        const rooms = await Promise.all(hashes.map((data) => hashToRoomInfo(data)));
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
    async function registerRoom(roomId, roomType, serverId, data, tags, ttlMs) {
        validateTags(tags);
        validateRequestedRoomTtl(ttlMs);
        const assignment = { roomId, roomType, data, status: 'requested' };
        const receivers = await client.eval(REGISTER_ROOM_SCRIPT, 4, keys.server(serverId), keys.room(roomId), keys.rooms, keys.roomsByServerId(serverId), roomId, roomType, serverId, JSON.stringify(data), JSON.stringify(tags), String(Date.now()), String(ttlMs), keys.roomAssigned(serverId), JSON.stringify(assignment));
        if (receivers === REGISTER_ROOM_SERVER_MISSING) {
            throw new ServerNotFoundError(serverId);
        }
        // on cluster, PUBLISH counts only the executing node's subscribers, so 0 proves nothing
        if (receivers === 0 && client instanceof Redis) {
            log.warn('room assigned but server not subscribed', { serverId, roomId });
        }
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
        const applied = await client.eval(ROOM_READY_SCRIPT, 1, keys.room(roomId), endpoint, roomSecret, keys.roomReady(roomId), roomId);
        return applied === 1;
    }
    async function roomFailure(roomId, reason) {
        // publish the failure BEFORE deleting the records so a waitForRoom waiter
        // rejects with the real cause rather than eventually timing out.
        await client.publish(keys.roomFailed(roomId), reason);
        await unregisterRoom(roomId);
    }
    async function waitForRoom(roomId, timeoutMs, registered) {
        return waitForRoomRunning(roomId, timeoutMs, registered, getRoomInfo, subscribeRoomSignals(roomId));
    }
    // both channels or neither; a half-subscribed pair would leak the survivor
    function subscribeRoomSignals(roomId) {
        return async (handlers) => {
            const [ready, failed] = await Promise.allSettled([
                subscribeChannel(keys.roomReady(roomId), () => handlers.ready()),
                subscribeChannel(keys.roomFailed(roomId), (_ch, reason) => handlers.failed(reason)),
            ]);
            if (ready.status === 'fulfilled' && failed.status === 'fulfilled') {
                return () => {
                    ready.value();
                    failed.value();
                };
            }
            const outcomes = [ready, failed];
            for (const outcome of outcomes) {
                if (outcome.status === 'fulfilled')
                    outcome.value();
            }
            const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
            throw rejection?.reason;
        };
    }
    async function getRoomInfo(roomId) {
        const data = await client.hgetall(keys.room(roomId));
        return hashToRoomInfo(data);
    }
    async function listRooms(filter) {
        const roomIds = await client.smembers(keys.rooms);
        if (roomIds.length === 0)
            return [];
        const { hashes, stale } = await readRoomHashes(roomIds);
        if (stale.length > 0) {
            await client.srem(keys.rooms, ...stale);
        }
        const rooms = await Promise.all(hashes.map((data) => hashToRoomInfo(data)));
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
        validateTags(options.tags);
        const key = keys.server(options.serverId);
        const nowMs = await redisNowMs();
        const tx = client.multi();
        // HSETNX recreating a reaped hash is the reliable reap signal; an EXISTS before the write can race the reap
        tx.hsetnx(key, 'serverId', options.serverId);
        // first-insert-only tags — preserves later add/removeServerTags writes
        tx.hsetnx(key, 'tags', JSON.stringify(options.tags));
        tx.hset(key, {
            endpoint: options.endpoint,
            roomTypes: JSON.stringify(options.roomTypes),
            lastHeartbeat: String(nowMs),
        });
        tx.sadd(keys.servers, options.serverId);
        // last command in the transaction reads the post-write tags so the
        // caller can refresh its in-memory cache without a second round-trip.
        tx.hget(key, 'tags');
        const txResults = await tx.exec();
        // tx.exec() returns null only if the transaction was discarded (e.g.,
        // WATCH conflict — we don't use WATCH, so this should not happen).
        const registered = txResults?.[0]?.[1] === 1;
        const tagsRaw = (txResults?.[4]?.[1] ?? null);
        const tags = tagsRaw ? JSON.parse(tagsRaw) : {};
        if (registered) {
            // evict any previous server on this endpoint: a restarted process has a fresh serverId
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
        // collect desired rooms in the same call. paying for the second
        // round-trip here vs on a separate reconcile tick — net halves the
        // control-plane round-trip count.
        const roomIds = await client.smembers(keys.roomsByServerId(options.serverId));
        const desiredRooms = [];
        if (roomIds.length > 0) {
            const { hashes, stale } = await readRoomHashes(roomIds);
            if (stale.length > 0) {
                await client.srem(keys.roomsByServerId(options.serverId), ...stale);
            }
            for (const data of hashes) {
                desiredRooms.push({
                    roomId: data.roomId,
                    roomType: data.roomType,
                    data: JSON.parse(data.data || '{}'),
                    status: (data.status || 'requested'),
                });
            }
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
    // batch-read server hashes in a single pipeline. returns the live hashes and
    // collects stale index ids for cleanup.
    async function readServerHashes(serverIds) {
        const pipeline = client.pipeline();
        for (const serverId of serverIds) {
            pipeline.hgetall(keys.server(serverId));
        }
        const results = await pipeline.exec();
        const hashes = [];
        const stale = [];
        for (let i = 0; i < serverIds.length; i++) {
            const data = (results?.[i]?.[1] ?? {});
            if (data.serverId) {
                hashes.push(data);
            }
            else {
                stale.push(serverIds[i]);
            }
        }
        return { hashes, stale };
    }
    async function listServers(filter) {
        const cutoff = (await redisNowMs()) - staleServerMs;
        const serverIds = await client.smembers(keys.servers);
        if (serverIds.length === 0)
            return [];
        const { hashes, stale } = await readServerHashes(serverIds);
        if (stale.length > 0) {
            await client.srem(keys.servers, ...stale);
        }
        const servers = await Promise.all(hashes.map(async (data) => {
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
        const cutoff = (await redisNowMs()) - staleServerMs;
        const serverIds = await client.smembers(keys.servers);
        if (serverIds.length === 0)
            return [];
        const { hashes, stale } = await readServerHashes(serverIds);
        if (stale.length > 0) {
            await client.srem(keys.servers, ...stale);
        }
        const servers = await Promise.all(hashes.map(async (data) => {
            const lastHeartbeat = Number(data.lastHeartbeat);
            // only include servers whose heartbeat IS older than cutoff
            if (lastHeartbeat >= cutoff)
                return null;
            return hashToServerInfo(data);
        }));
        return servers.filter((s) => s !== null);
    }
    async function reapServer(serverId) {
        const cutoff = (await redisNowMs()) - staleServerMs;
        const reaped = await client.eval(REAP_SERVER_SCRIPT, 4, keys.server(serverId), keys.roomsByServerId(serverId), keys.rooms, keys.servers, serverId, String(cutoff), keys.room(''), keys.clientsByRoom(''), keys.client(''));
        return reaped === 1;
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
            // an assignment push is only ever sent for a freshly requested room
            callback({ roomId: parsed.roomId, roomType: parsed.roomType, data: parsed.data, status: 'requested' });
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
        destroy() {
            if (canaryTimer)
                clearInterval(canaryTimer);
            canaryTimer = null;
            // the subscriber is ours (a duplicate); the caller's client is theirs to close
            subscriber?.disconnect();
            subscriber = null;
            channelListeners.clear();
            pendingSubscribes.clear();
        },
        _internal: {
            local: false,
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
            reapServer,
            getServer,
            subscribeRoomAssignments,
            tryAcquireLeader,
            renewLeader,
            releaseLeader,
        },
    };
}
// default staleness threshold — servers older than this are considered dead
const DEFAULT_STALE_SERVER_MS = 30_000;
// tcp keepalive idle for the subscriber connection (see duplicateForSubscriber)
const SUBSCRIBER_KEEPALIVE_MS = 30_000;
// REGISTER_ROOM_SCRIPT's reply when the target server has no record
const REGISTER_ROOM_SERVER_MISSING = -1;
// room, ttl, both indexes and the notify in one atomic step; replies with the PUBLISH receiver count
// KEYS: server hash, room hash, rooms set, rooms-by-server set
// ARGV: roomId, roomType, serverId, data, tags, createdAt, ttlMs, assigned channel, assignment
const REGISTER_ROOM_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], 'endpoint') == 0 then return ${REGISTER_ROOM_SERVER_MISSING} end
redis.call('HSET', KEYS[2], 'roomId', ARGV[1], 'roomType', ARGV[2], 'serverId', ARGV[3], 'status', 'requested', 'data', ARGV[4], 'tags', ARGV[5], 'createdAt', ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[7])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('SADD', KEYS[4], ARGV[1])
return redis.call('PUBLISH', ARGV[8], ARGV[9])
`;
// marks a room running only if its record still exists, so a late ready can't recreate a ttl-less hash
// KEYS: room hash. ARGV: endpoint, roomSecret, ready channel, roomId
const ROOM_READY_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'status', 'running', 'endpoint', ARGV[1], 'roomSecret', ARGV[2])
redis.call('PERSIST', KEYS[1])
redis.call('PUBLISH', ARGV[3], ARGV[4])
return 1
`;
// unregisters a server and everything it owns only if still stale; derived per-room keys share KEYS' hashtag slot
// KEYS: server hash, rooms-by-server set, rooms set, servers set
// ARGV: serverId, cutoffMs, room key prefix, clients-by-room key prefix, client key prefix
const REAP_SERVER_SCRIPT = `
local last = redis.call('HGET', KEYS[1], 'lastHeartbeat')
if last and tonumber(last) >= tonumber(ARGV[2]) then return 0 end
local roomIds = redis.call('SMEMBERS', KEYS[2])
for _, roomId in ipairs(roomIds) do
    local clientsKey = ARGV[4] .. roomId
    local clientIds = redis.call('SMEMBERS', clientsKey)
    for _, clientId in ipairs(clientIds) do
        redis.call('DEL', ARGV[5] .. clientId)
    end
    redis.call('DEL', clientsKey)
    redis.call('DEL', ARGV[3] .. roomId)
    redis.call('SREM', KEYS[3], roomId)
end
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
`;
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
        // pub/sub channel for room-failed notifications
        roomFailed: (roomId) => `${prefix}room-failed:${roomId}`,
        // pub/sub channel for room assignment notifications (per-server)
        roomAssigned: (serverId) => `${prefix}room-assigned:${serverId}`,
        // pub/sub channel a driver instance publishes to itself to prove its subscriber receives
        canary: (driverInstanceId) => `${prefix}canary:${driverInstanceId}`,
        // schema version — checked on server registration
        schemaVersion: `${prefix}schema_version`,
    };
}

export { createRedisDriver };
//# sourceMappingURL=driver-redis.js.map
