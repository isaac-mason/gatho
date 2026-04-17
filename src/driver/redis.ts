import Redis, { type Cluster } from 'ioredis';
import { RoomNotFoundError, RoomNotRunningError, RoomStartError, RoomTimeoutError, ServerNotFoundError } from 'gatho/common';
import { jwtSign } from '../common/jwt';
import type {
    ClientInfo,
    ClientReservation,
    DesiredRoom,
    Driver,
    ListRoomsFilter,
    ListServersFilter,
    RegisterServerOptions,
    RoomData,
    RoomInfo,
    RoomStatus,
    ServerInfo,
} from './types';
import { validateTags } from './types';

/**
 * redis driver implementation using ioredis
 * multi-server production driver backed by redis
 * works with standalone redis, sentinel, and redis cluster.
 * leverages native key expiry for reservations, set indexes for fast lookups
 */
export function createRedisDriver(options: RedisDriverOptions = {}): Driver {
    const prefix = options.prefix ?? 'gatho:{gatho}:';
    const keys = createKeys(prefix);

    const client = options.client ?? new Redis(options.url ?? process.env.GATHO_REDIS_URL ?? 'redis://localhost:6379');

    // shared subscriber connection — lazily created on first waitForRoom call.
    // ioredis requires a dedicated connection for subscriptions (subscribed
    // clients can't issue normal commands). instead of creating one per call,
    // we share a single connection and multiplex channels via a listener map.
    let subscriber: Redis | Cluster | null = null;
    const channelListeners = new Map<string, Set<(channel: string, message: string) => void>>();

    function getSubscriber(): Redis | Cluster {
        if (!subscriber) {
            subscriber = client.duplicate();
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

    // helper: get client info for all clients in a room
    async function getClientsForRoom(roomId: string): Promise<ClientInfo[]> {
        const clientIds = await client.smembers(keys.clientsByRoom(roomId));
        const result: ClientInfo[] = [];
        for (const clientId of clientIds) {
            const clientData = await client.hgetall(keys.client(clientId));
            if (clientData.clientId) {
                result.push({
                    clientId: clientData.clientId,
                    status: clientData.status as ClientInfo['status'],
                    tags: clientData.tags ? (JSON.parse(clientData.tags) as Record<string, string>) : {},
                });
            } else {
                // stale index entry — client key expired/deleted
                await client.srem(keys.clientsByRoom(roomId), clientId);
            }
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

    // helper: get all rooms for a server
    async function getRoomsForServer(serverId: string): Promise<RoomInfo[]> {
        const roomIds = await client.smembers(keys.roomsByServerId(serverId));
        if (roomIds.length === 0) return [];

        const rooms = await Promise.all(
            roomIds.map(async (roomId) => {
                const data = await client.hgetall(keys.room(roomId));
                if (!data || !data.roomId) {
                    // stale index entry
                    await client.srem(keys.roomsByServerId(serverId), roomId);
                    return null;
                }
                return hashToRoomInfo(data);
            }),
        );
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

    async function roomFailure(roomId: string, _reason: string): Promise<void> {
        await unregisterRoom(roomId);
    }

    async function waitForRoom(roomId: string, timeoutMs: number): Promise<RoomInfo> {
        // check if already running before subscribing
        const existing = await getRoomInfo(roomId);
        if (existing && existing.status === 'running') return existing;

        const channel = keys.roomReady(roomId);

        return new Promise<RoomInfo>((resolve, reject) => {
            let settled = false;
            let unsub: (() => void) | null = null;

            const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (unsub) unsub();
            };

            const timer = setTimeout(() => {
                cleanup();
                reject(new RoomTimeoutError(roomId, timeoutMs));
            }, timeoutMs);

            const listener = (_ch: string, _msg: string) => {
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

        const rooms = await Promise.all(roomIds.map((roomId) => getRoomInfo(roomId)));
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

    async function getDesiredState(serverId: string): Promise<DesiredRoom[]> {
        const roomIds = await client.smembers(keys.roomsByServerId(serverId));
        if (roomIds.length === 0) return [];

        const rooms = await Promise.all(
            roomIds.map(async (roomId) => {
                const data = await client.hgetall(keys.room(roomId));
                if (!data || !data.roomId) {
                    // stale index entry
                    await client.srem(keys.roomsByServerId(serverId), roomId);
                    return null;
                }
                return {
                    roomId: data.roomId,
                    roomType: data.roomType,
                    data: JSON.parse(data.data || '{}') as RoomData,
                };
            }),
        );

        return rooms.filter((r): r is DesiredRoom => r !== null);
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

        const clientId = crypto.randomUUID();
        const expiresAt = Date.now() + ttl;

        // mint jwt signed with the room's secret — room verifies locally, zero ipc
        const token = jwtSign({ clientId, roomId, exp: expiresAt, data: data ?? {} }, roomData.roomSecret);

        // store client record
        await client.hset(keys.client(clientId), {
            clientId,
            roomId,
            status: 'reserved',
            expiresAt: String(expiresAt),
            tags: JSON.stringify(clientTags),
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

    async function connectClient(clientId: string): Promise<void> {
        // update status to connected and remove TTL (connected clients persist until disconnect)
        await client.hset(keys.client(clientId), {
            status: 'connected',
            expiresAt: '0',
        });

        // remove TTL — connected clients don't expire
        await client.persist(keys.client(clientId));
    }

    async function disconnectClient(clientId: string): Promise<void> {
        const clientData = await client.hgetall(keys.client(clientId));
        if (clientData.roomId) {
            await client.srem(keys.clientsByRoom(clientData.roomId), clientId);
        }
        await client.del(keys.client(clientId));
    }

    async function registerServer(options: RegisterServerOptions): Promise<void> {
        validateTags(options.tags);

        // ensure redis data matches our schema — flushes all prefixed keys on mismatch
        await ensureSchemaVersion();

        await client.hset(keys.server(options.serverId), {
            serverId: options.serverId,
            endpoint: options.endpoint,
            tags: JSON.stringify(options.tags),
            roomTypes: JSON.stringify(options.roomTypes),
            lastHeartbeat: String(Date.now()),
        });

        await client.sadd(keys.servers, options.serverId);
    }

    async function heartbeat(serverId: string): Promise<void> {
        await client.hset(keys.server(serverId), {
            lastHeartbeat: String(Date.now()),
        });
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

    async function listServers(filter?: ListServersFilter): Promise<ServerInfo[]> {
        const cutoff = Date.now() - STALE_MS;
        const serverIds = await client.smembers(keys.servers);
        if (serverIds.length === 0) return [];

        const servers = await Promise.all(
            serverIds.map(async (serverId) => {
                const data = await client.hgetall(keys.server(serverId));
                if (!data || !data.serverId) {
                    await client.srem(keys.servers, serverId);
                    return null;
                }

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
        const cutoff = Date.now() - STALE_MS;
        const serverIds = await client.smembers(keys.servers);
        if (serverIds.length === 0) return [];

        const servers = await Promise.all(
            serverIds.map(async (serverId) => {
                const data = await client.hgetall(keys.server(serverId));
                if (!data || !data.serverId) {
                    await client.srem(keys.servers, serverId);
                    return null;
                }

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
            registerRoom,
            unregisterRoom,
            roomReady,
            roomFailure,
            waitForRoom,
            getRoomInfo,
            listRooms,
            addRoomTags,
            removeRoomTags,
            getDesiredState,
            reserveClient,
            connectClient,
            disconnectClient,
            registerServer,
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
};

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
        // pub/sub channel for room assignment notifications (per-server)
        roomAssigned: (serverId: string) => `${prefix}room-assigned:${serverId}`,
        // schema version — checked on server registration
        schemaVersion: `${prefix}schema_version`,
    };
}
