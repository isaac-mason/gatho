import Redis, { type Cluster } from 'ioredis';
import { jwtSign } from '../common/jwt';
import { log } from '../common/logger';
// import runtime values (error classes AND validators) from the `gatho/driver`
// entry (external in the redis bundle) rather than relatively. this keeps ONE
// class identity across the driver/redis split: the error classes these throw
// (RoomFailedError, PayloadTooLargeError, InvalidTagError, ...) are the same
// objects the sdk re-exports from `gatho/driver`, so `err instanceof X` holds
// when a redis rejection propagates through the sdk. type-only imports stay
// relative since they are erased at build time.
import {
    RoomFailedError,
    RoomNotFoundError,
    RoomNotRunningError,
    RoomStartError,
    RoomTimeoutError,
    ServerNotFoundError,
    validateTags,
    validateReserveData,
    validateReserveTagsSize,
} from 'gatho/driver';
import type {
    ClientInfo,
    ClientReservation,
    DesiredRoom,
    Driver,
    ListRoomsFilter,
    ListServersFilter,
    HeartbeatOptions,
    HeartbeatResult,
    RoomData,
    RoomInfo,
    RoomStatus,
    ServerInfo,
} from './types';

function attachLifecycleLogging(c: Redis | Cluster, name: 'main' | 'subscriber'): void {
    c.on('error', (err: Error) => log.error('redis connection error', { connection: name, err }));
    c.on('end', () => log.warn('redis connection ended', { connection: name }));
    c.on('reconnecting', (ms: number) => log.warn('redis reconnecting', { connection: name, delayMs: ms }));
    c.on('ready', () => log.info('redis ready', { connection: name }));
}

/**
 * redis driver implementation using ioredis
 * multi-server production driver backed by redis
 * works with standalone redis, sentinel, and redis cluster.
 * leverages native key expiry for reservations, set indexes for fast lookups
 */
export function createRedisDriver(options: RedisDriverOptions = {}): Driver {
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

    // shared subscriber connection — lazily created on first waitForRoom call.
    // ioredis requires a dedicated connection for subscriptions (subscribed
    // clients can't issue normal commands). instead of creating one per call,
    // we share a single connection and multiplex channels via a listener map.
    let subscriber: Redis | Cluster | null = null;
    const channelListeners = new Map<string, Set<(channel: string, message: string) => void>>();

    function getSubscriber(): Redis | Cluster {
        if (!subscriber) {
            subscriber = client.duplicate();
            attachLifecycleLogging(subscriber, 'subscriber');
            subscriber.on('message', (ch: string, msg: string) => {
                const listeners = channelListeners.get(ch);
                if (!listeners) return;
                for (const listener of listeners) {
                    listener(ch, msg);
                }
            });
        }
        return subscriber;
    }

    // subscribe a listener to a channel. returns an unsubscribe function.
    // first listener for a channel subscribes, last removal unsubscribes.
    async function subscribeChannel(channel: string, listener: (ch: string, msg: string) => void): Promise<() => void> {
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
            if (removed) return;
            removed = true;

            const set = channelListeners.get(channel);
            if (set) {
                set.delete(listener);
                if (set.size === 0) {
                    channelListeners.delete(channel);
                    sub.unsubscribe(channel).catch(() => {});
                }
            }
        };
    }

    // flush all keys with our prefix if the stored schema version doesn't
    // match. uses SCAN to avoid blocking redis on large keyspaces, and
    // UNLINK (async DEL) per-key for redis cluster compatibility.
    async function ensureSchemaVersion(): Promise<void> {
        const stored = await client.get(keys.schemaVersion);
        if (stored === String(SCHEMA_VERSION)) return;

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
    async function getClientsForRoom(roomId: string): Promise<ClientInfo[]> {
        const clientIds = await client.smembers(keys.clientsByRoom(roomId));
        if (clientIds.length === 0) return [];

        const pipeline = client.pipeline();
        for (const clientId of clientIds) {
            pipeline.hgetall(keys.client(clientId));
        }
        const results = await pipeline.exec();

        const result: ClientInfo[] = [];
        const stale: string[] = [];
        for (let i = 0; i < clientIds.length; i++) {
            const clientData = (results?.[i]?.[1] ?? {}) as Record<string, string>;
            if (clientData.clientId) {
                result.push({
                    clientId: clientData.clientId,
                    status: clientData.status as ClientInfo['status'],
                    tags: clientData.tags ? (JSON.parse(clientData.tags) as Record<string, string>) : {},
                    connectedAt: clientData.connectedAt ? Number(clientData.connectedAt) : 0,
                });
            } else {
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
    async function hashToRoomInfo(data: Record<string, string>): Promise<RoomInfo | null> {
        if (!data || !data.roomId) return null;
        const clients = await getClientsForRoom(data.roomId);
        return {
            roomId: data.roomId,
            roomType: data.roomType,
            serverId: data.serverId,
            status: (data.status || 'requested') as RoomStatus,
            endpoint: data.endpoint || null,
            clients,
            data: JSON.parse(data.data || '{}') as RoomData,
            tags: JSON.parse(data.tags || '{}') as Record<string, string>,
            createdAt: Number(data.createdAt),
        };
    }

    // batch-read room hashes for a set of ids in a single pipeline. returns the
    // live room hashes (in the same order) and collects stale index ids so the
    // caller can srem them from whatever index they came from.
    async function readRoomHashes(roomIds: string[]): Promise<{ hashes: Record<string, string>[]; stale: string[] }> {
        const pipeline = client.pipeline();
        for (const roomId of roomIds) {
            pipeline.hgetall(keys.room(roomId));
        }
        const results = await pipeline.exec();

        const hashes: Record<string, string>[] = [];
        const stale: string[] = [];
        for (let i = 0; i < roomIds.length; i++) {
            const data = (results?.[i]?.[1] ?? {}) as Record<string, string>;
            if (data.roomId) {
                hashes.push(data);
            } else {
                stale.push(roomIds[i]);
            }
        }
        return { hashes, stale };
    }

    // helper: get all rooms for a server. one smembers + one pipeline of room
    // hgetalls, then hashToRoomInfo fans out per-room client reads.
    async function getRoomsForServer(serverId: string): Promise<RoomInfo[]> {
        const roomIds = await client.smembers(keys.roomsByServerId(serverId));
        if (roomIds.length === 0) return [];

        const { hashes, stale } = await readRoomHashes(roomIds);
        if (stale.length > 0) {
            await client.srem(keys.roomsByServerId(serverId), ...stale);
        }

        const rooms = await Promise.all(hashes.map((data) => hashToRoomInfo(data)));
        return rooms.filter((r): r is RoomInfo => r !== null);
    }

    // helper: build ServerInfo from redis hash data
    async function hashToServerInfo(data: Record<string, string>): Promise<ServerInfo | null> {
        if (!data || !data.serverId) return null;
        return {
            serverId: data.serverId,
            endpoint: data.endpoint,
            lastHeartbeat: Number(data.lastHeartbeat),
            rooms: await getRoomsForServer(data.serverId),
            tags: JSON.parse(data.tags || '{}') as Record<string, string>,
            roomTypes: JSON.parse(data.roomTypes || '[]') as string[],
        };
    }

    async function registerRoom(
        roomId: string,
        roomType: string,
        serverId: string,
        data: RoomData,
        tags: Record<string, string>,
    ): Promise<void> {
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

    async function unregisterRoom(roomId: string): Promise<void> {
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

    async function roomReady(roomId: string, endpoint: string, roomSecret: string): Promise<void> {
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

    async function roomFailure(roomId: string, reason: string): Promise<void> {
        // publish the failure BEFORE deleting the records so a waitForRoom waiter
        // rejects with the real cause rather than eventually timing out.
        await client.publish(keys.roomFailed(roomId), reason);
        await unregisterRoom(roomId);
    }

    async function waitForRoom(roomId: string, timeoutMs: number): Promise<RoomInfo> {
        // check if already running before subscribing
        const existing = await getRoomInfo(roomId);
        if (existing && existing.status === 'running') return existing;

        const readyChannel = keys.roomReady(roomId);
        const failedChannel = keys.roomFailed(roomId);

        return new Promise<RoomInfo>((resolve, reject) => {
            let settled = false;
            const unsubs: (() => void)[] = [];

            const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                for (const u of unsubs) u();
            };

            const timer = setTimeout(() => {
                cleanup();
                reject(new RoomTimeoutError(roomId, timeoutMs));
            }, timeoutMs);

            const readyListener = (_ch: string, _msg: string) => {
                cleanup();
                // fetch full room info
                getRoomInfo(roomId)
                    .then((info) => {
                        if (info) {
                            resolve(info);
                        } else {
                            reject(new RoomStartError(roomId));
                        }
                    })
                    .catch(reject);
            };

            const failedListener = (_ch: string, msg: string) => {
                cleanup();
                reject(new RoomFailedError(roomId, msg));
            };

            // subscribe to both the ready and failed channels. either one settles
            // the promise; whichever fires first wins.
            Promise.all([subscribeChannel(readyChannel, readyListener), subscribeChannel(failedChannel, failedListener)])
                .then(([unsubReady, unsubFailed]) => {
                    unsubs.push(unsubReady, unsubFailed);

                    // if we settled while awaiting subscribe (timeout fired), clean up
                    if (settled) {
                        unsubReady();
                        unsubFailed();
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
                        .catch(() => {});
                })
                .catch((err) => {
                    cleanup();
                    reject(err);
                });
        });
    }

    async function getRoomInfo(roomId: string): Promise<RoomInfo | null> {
        const data = await client.hgetall(keys.room(roomId));
        return hashToRoomInfo(data);
    }

    async function listRooms(filter?: ListRoomsFilter): Promise<RoomInfo[]> {
        const roomIds = await client.smembers(keys.rooms);
        if (roomIds.length === 0) return [];

        const { hashes, stale } = await readRoomHashes(roomIds);
        if (stale.length > 0) {
            await client.srem(keys.rooms, ...stale);
        }

        const rooms = await Promise.all(hashes.map((data) => hashToRoomInfo(data)));
        let result = rooms.filter((r): r is RoomInfo => r !== null);

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

    async function addRoomTags(roomId: string, tags: Record<string, string>): Promise<void> {
        validateTags(tags);
        const data = await client.hgetall(keys.room(roomId));
        if (!data || !data.roomId) throw new RoomNotFoundError(roomId);
        const existing = JSON.parse(data.tags || '{}') as Record<string, string>;
        const merged = { ...existing, ...tags };
        await client.hset(keys.room(roomId), { tags: JSON.stringify(merged) });
    }

    async function removeRoomTags(roomId: string, tagKeys: string[]): Promise<void> {
        const data = await client.hgetall(keys.room(roomId));
        if (!data || !data.roomId) throw new RoomNotFoundError(roomId);
        const existing = JSON.parse(data.tags || '{}') as Record<string, string>;
        for (const key of tagKeys) {
            delete existing[key];
        }
        await client.hset(keys.room(roomId), { tags: JSON.stringify(existing) });
    }

    async function reserveClient(
        roomId: string,
        ttl: number,
        data?: Record<string, unknown>,
        tags?: Record<string, string>,
    ): Promise<ClientReservation> {
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
        const token = await jwtSign(
            { clientId, roomId, exp: expiresAt, data: data ?? {}, tags: clientTags },
            roomData.roomSecret,
        );

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

    async function connectClient(clientId: string, roomId: string, tags: Record<string, string>): Promise<void> {
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

    async function disconnectClient(clientId: string): Promise<void> {
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
    async function heartbeat(options: HeartbeatOptions): Promise<HeartbeatResult> {
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
                if (id === options.serverId) continue;
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
        const tagsRaw = (txResults?.[3]?.[1] ?? null) as string | null;
        const tags = tagsRaw ? (JSON.parse(tagsRaw) as Record<string, string>) : {};

        // collect desired rooms in the same call. paying for the second
        // round-trip here vs on a separate reconcile tick — net halves the
        // control-plane round-trip count.
        const roomIds = await client.smembers(keys.roomsByServerId(options.serverId));
        const desiredRooms: DesiredRoom[] = [];
        if (roomIds.length > 0) {
            const { hashes, stale } = await readRoomHashes(roomIds);
            if (stale.length > 0) {
                await client.srem(keys.roomsByServerId(options.serverId), ...stale);
            }
            for (const data of hashes) {
                desiredRooms.push({
                    roomId: data.roomId,
                    roomType: data.roomType,
                    data: JSON.parse(data.data || '{}') as RoomData,
                });
            }
        }

        return { tags, desiredRooms, registered };
    }

    async function unregisterServer(serverId: string): Promise<void> {
        // clean up all rooms owned by this server
        const roomIds = await client.smembers(keys.roomsByServerId(serverId));
        for (const roomId of roomIds) {
            await unregisterRoom(roomId);
        }
        await client.del(keys.roomsByServerId(serverId));

        await client.del(keys.server(serverId));
        await client.srem(keys.servers, serverId);
    }

    async function addServerTags(serverId: string, tags: Record<string, string>): Promise<void> {
        validateTags(tags);
        const data = await client.hgetall(keys.server(serverId));
        if (!data || !data.serverId) throw new ServerNotFoundError(serverId);
        const existing = JSON.parse(data.tags || '{}') as Record<string, string>;
        const merged = { ...existing, ...tags };
        await client.hset(keys.server(serverId), { tags: JSON.stringify(merged) });
    }

    async function removeServerTags(serverId: string, tagKeys: string[]): Promise<void> {
        const data = await client.hgetall(keys.server(serverId));
        if (!data || !data.serverId) throw new ServerNotFoundError(serverId);
        const existing = JSON.parse(data.tags || '{}') as Record<string, string>;
        for (const key of tagKeys) {
            delete existing[key];
        }
        await client.hset(keys.server(serverId), { tags: JSON.stringify(existing) });
    }

    // batch-read server hashes in a single pipeline. returns the live hashes and
    // collects stale index ids for cleanup.
    async function readServerHashes(serverIds: string[]): Promise<{ hashes: Record<string, string>[]; stale: string[] }> {
        const pipeline = client.pipeline();
        for (const serverId of serverIds) {
            pipeline.hgetall(keys.server(serverId));
        }
        const results = await pipeline.exec();

        const hashes: Record<string, string>[] = [];
        const stale: string[] = [];
        for (let i = 0; i < serverIds.length; i++) {
            const data = (results?.[i]?.[1] ?? {}) as Record<string, string>;
            if (data.serverId) {
                hashes.push(data);
            } else {
                stale.push(serverIds[i]);
            }
        }
        return { hashes, stale };
    }

    async function listServers(filter?: ListServersFilter): Promise<ServerInfo[]> {
        const cutoff = Date.now() - staleServerMs;
        const serverIds = await client.smembers(keys.servers);
        if (serverIds.length === 0) return [];

        const { hashes, stale } = await readServerHashes(serverIds);
        if (stale.length > 0) {
            await client.srem(keys.servers, ...stale);
        }

        const servers = await Promise.all(
            hashes.map(async (data) => {
                const lastHeartbeat = Number(data.lastHeartbeat);
                if (lastHeartbeat < cutoff) return null;
                return hashToServerInfo(data);
            }),
        );

        let result = servers.filter((s): s is ServerInfo => s !== null);

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

    async function listStaleServers(): Promise<ServerInfo[]> {
        const cutoff = Date.now() - staleServerMs;
        const serverIds = await client.smembers(keys.servers);
        if (serverIds.length === 0) return [];

        const { hashes, stale } = await readServerHashes(serverIds);
        if (stale.length > 0) {
            await client.srem(keys.servers, ...stale);
        }

        const servers = await Promise.all(
            hashes.map(async (data) => {
                const lastHeartbeat = Number(data.lastHeartbeat);
                // only include servers whose heartbeat IS older than cutoff
                if (lastHeartbeat >= cutoff) return null;
                return hashToServerInfo(data);
            }),
        );

        return servers.filter((s): s is ServerInfo => s !== null);
    }

    async function getServer(serverId: string): Promise<ServerInfo | null> {
        const data = await client.hgetall(keys.server(serverId));
        return hashToServerInfo(data);
    }

    async function subscribeRoomAssignments(serverId: string, callback: (room: DesiredRoom) => void): Promise<() => void> {
        const channel = keys.roomAssigned(serverId);
        const listener = (_ch: string, msg: string) => {
            let parsed: DesiredRoom;
            try {
                parsed = JSON.parse(msg) as DesiredRoom;
            } catch {
                console.error('[gatho] malformed room-assigned message, discarding', { channel, msg });
                return;
            }
            callback(parsed);
        };
        return subscribeChannel(channel, listener);
    }

    async function tryAcquireLeader(serverId: string): Promise<boolean> {
        // SET NX PX — atomic acquire, only succeeds if key doesn't exist
        const result = await client.set(keys.leader, serverId, 'PX', LEADER_LOCK_TTL_MS, 'NX');
        return result === 'OK';
    }

    async function renewLeader(serverId: string): Promise<boolean> {
        // compare-and-swap: only extend if we still own the lock
        const result = await client.eval(
            `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end`,
            1,
            keys.leader,
            serverId,
            String(LEADER_LOCK_TTL_MS),
        );
        return result === 1;
    }

    async function releaseLeader(serverId: string): Promise<void> {
        // compare-and-swap: only delete if we still own the lock
        await client.eval(
            `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`,
            1,
            keys.leader,
            serverId,
        );
    }

    return {
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
            getServer,
            subscribeRoomAssignments,
            tryAcquireLeader,
            renewLeader,
            releaseLeader,
        },
    };
}

/** options for creating a redis driver */
export type RedisDriverOptions = {
    /**
     * an existing ioredis client instance (Redis or Cluster).
     * if provided, url is ignored.
     */
    client?: Redis | Cluster;
    /** redis connection url, defaults to $GATHO_REDIS_URL or redis://localhost:6379. ignored if client is provided. */
    url?: string;
    /**
     * key prefix for namespacing, defaults to "gatho:{gatho}:".
     * the {gatho} hash tag ensures all keys land on the same redis cluster slot,
     * while the leading "gatho:" keeps keys human-readable in redis-cli and GUIs.
     * if you override this, include a {hashtag} segment for cluster compatibility,
     * e.g. "myapp:{myapp}:".
     */
    prefix?: string;
    /**
     * how long (ms) a server may go without a heartbeat before it is treated as
     * dead — dropped from listServers and reaped (with its rooms) by the leader.
     * defaults to 30_000.
     *
     * tradeoff: a lower value fails a dead server over faster, but is less
     * tolerant of transient driver blips (a brief redis hiccup that delays a
     * heartbeat can trip a too-low threshold and reap a healthy server, killing
     * its rooms). a higher value tolerates blips at the cost of slower failover.
     * this must comfortably exceed the server's heartbeatIntervalMs (default
     * 5_000) — allow room for several missed beats plus round-trip jitter.
     */
    staleServerMs?: number;
};

// default staleness threshold — servers older than this are considered dead
const DEFAULT_STALE_SERVER_MS = 30_000;

// how long a 'requested' room hash lives before redis auto-expires it
const REQUESTED_ROOM_TTL_MS = 30_000;

// leader lock ttl — generous enough to survive transient redis hiccups
const LEADER_LOCK_TTL_MS = 30_000;

// bump this when the redis schema changes. on mismatch, all prefixed keys
// are flushed — servers and rooms are ephemeral, no migration needed.
const SCHEMA_VERSION = 2;

// key helpers - keep all redis key construction in one place
function createKeys(prefix: string) {
    return {
        // room hash: stores roomId, roomType, serverId, createdAt, data, tags, endpoint, roomSecret
        room: (roomId: string) => `${prefix}room:${roomId}`,
        // set of all room ids
        rooms: `${prefix}rooms`,
        // set of room ids by server id
        roomsByServerId: (serverId: string) => `${prefix}rooms:server:${serverId}`,
        // client hash: stores clientId, roomId, status, expiresAt
        client: (clientId: string) => `${prefix}client:${clientId}`,
        // set of client ids by room id
        clientsByRoom: (roomId: string) => `${prefix}clients:room:${roomId}`,
        // server hash: stores serverId, endpoint, lastHeartbeat, tags, roomTypes
        server: (serverId: string) => `${prefix}server:${serverId}`,
        // set of all server ids
        servers: `${prefix}servers`,
        // leader election lock
        leader: `${prefix}leader`,
        // pub/sub channel for room-ready notifications
        roomReady: (roomId: string) => `${prefix}room-ready:${roomId}`,
        // pub/sub channel for room-failed notifications
        roomFailed: (roomId: string) => `${prefix}room-failed:${roomId}`,
        // pub/sub channel for room assignment notifications (per-server)
        roomAssigned: (serverId: string) => `${prefix}room-assigned:${serverId}`,
        // schema version — checked on server registration
        schemaVersion: `${prefix}schema_version`,
    };
}
