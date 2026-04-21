// in-memory driver for dev mode
// single-process, no persistence
// used by 'gatho dev' where server and sdk are in the same process

import { EventEmitter } from 'node:events';
import { jwtSign } from '../common/jwt';
import { RoomNotFoundError, RoomNotRunningError, RoomTimeoutError, ServerNotFoundError } from './errors';
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

type RoomRecord = {
    roomId: string;
    roomType: string;
    serverId: string;
    status: RoomStatus;
    endpoint: string | null;
    roomSecret: string | null;
    data: RoomData;
    tags: Record<string, string>;
    createdAt: number;
};

type ClientRecord = {
    clientId: string;
    roomId: string;
    status: 'reserved' | 'connected';
    expiresAt: number;
    tags: Record<string, string>;
};

type ServerRecord = {
    serverId: string;
    endpoint: string;
    tags: Record<string, string>;
    roomTypes: string[];
    lastHeartbeat: number;
};

const STALE_MS = 30_000;
const PRUNE_INTERVAL_MS = 10_000;

/**
 * An in-memory driver.
 * good for local development, tests, and situationally onebox dev environments.
 * note that you must pass the same driver object to both the server and sdk in order for them to see each other's state.
 */
export function createMemoryDriver(): Driver {
    const rooms = new Map<string, RoomRecord>();
    const clients = new Map<string, ClientRecord>();
    const servers = new Map<string, ServerRecord>();
    const events = new EventEmitter();

    function getClientsForRoom(roomId: string): ClientInfo[] {
        const result: ClientInfo[] = [];
        for (const c of clients.values()) {
            if (c.roomId === roomId) {
                result.push({ clientId: c.clientId, status: c.status, tags: c.tags });
            }
        }
        return result;
    }

    function roomToInfo(r: RoomRecord): RoomInfo {
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

    function getRoomsForServer(serverId: string): RoomInfo[] {
        const result: RoomInfo[] = [];
        for (const r of rooms.values()) {
            if (r.serverId === serverId) result.push(roomToInfo(r));
        }
        return result;
    }

    function serverToInfo(s: ServerRecord): ServerInfo {
        return {
            serverId: s.serverId,
            endpoint: s.endpoint,
            lastHeartbeat: s.lastHeartbeat,
            rooms: getRoomsForServer(s.serverId),
            tags: { ...s.tags },
            roomTypes: [...s.roomTypes],
        };
    }

    function deleteClientsForRoom(roomId: string): void {
        for (const [id, c] of clients) {
            if (c.roomId === roomId) {
                clients.delete(id);
            }
        }
    }

    // prune stale servers (and their rooms/clients) + expired client reservations
    function prune(): void {
        const now = Date.now();
        const staleCutoff = now - STALE_MS;

        // collect stale server ids
        const staleServerIds: string[] = [];
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

    async function registerRoom(
        roomId: string,
        roomType: string,
        serverId: string,
        data: RoomData,
        tags: Record<string, string>,
    ): Promise<void> {
        if (!servers.has(serverId)) throw new ServerNotFoundError(serverId);
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

    async function unregisterRoom(roomId: string): Promise<void> {
        deleteClientsForRoom(roomId);
        rooms.delete(roomId);
    }

    async function roomReady(roomId: string, endpoint: string, roomSecret: string): Promise<void> {
        const r = rooms.get(roomId);
        if (r) {
            r.status = 'running';
            r.endpoint = endpoint;
            r.roomSecret = roomSecret;
            events.emit(`room-ready:${roomId}`, roomToInfo(r));
        }
    }

    async function roomFailure(roomId: string, _reason: string): Promise<void> {
        deleteClientsForRoom(roomId);
        rooms.delete(roomId);
    }

    async function waitForRoom(roomId: string, timeoutMs: number): Promise<RoomInfo> {
        // check if already running
        const r = rooms.get(roomId);
        if (r && r.status === 'running') return roomToInfo(r);

        return new Promise<RoomInfo>((resolve, reject) => {
            const timer = setTimeout(() => {
                events.removeListener(`room-ready:${roomId}`, onReady);
                reject(new RoomTimeoutError(roomId, timeoutMs));
            }, timeoutMs);

            function onReady(info: RoomInfo) {
                clearTimeout(timer);
                resolve(info);
            }

            events.once(`room-ready:${roomId}`, onReady);
        });
    }

    async function getRoomInfo(roomId: string): Promise<RoomInfo | null> {
        const r = rooms.get(roomId);
        return r ? roomToInfo(r) : null;
    }

    async function listRooms(filter?: ListRoomsFilter): Promise<RoomInfo[]> {
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

    async function addRoomTags(roomId: string, tags: Record<string, string>): Promise<void> {
        const r = rooms.get(roomId);
        if (!r) throw new RoomNotFoundError(roomId);
        validateTags(tags);
        Object.assign(r.tags, tags);
    }

    async function removeRoomTags(roomId: string, keys: string[]): Promise<void> {
        const r = rooms.get(roomId);
        if (!r) throw new RoomNotFoundError(roomId);
        for (const key of keys) delete r.tags[key];
    }

    async function getDesiredState(serverId: string): Promise<DesiredRoom[]> {
        const result: DesiredRoom[] = [];
        for (const r of rooms.values()) {
            if (r.serverId === serverId) {
                result.push({ roomId: r.roomId, roomType: r.roomType, data: r.data });
            }
        }
        return result;
    }

    async function reserveClient(
        roomId: string,
        ttl: number,
        data?: Record<string, unknown>,
        tags?: Record<string, string>,
    ): Promise<ClientReservation> {
        const r = rooms.get(roomId);
        if (!r) throw new RoomNotFoundError(roomId);
        if (r.status !== 'running' || !r.roomSecret || !r.endpoint) throw new RoomNotRunningError(roomId);

        const clientTags = tags ?? {};
        validateTags(clientTags);

        const clientId = crypto.randomUUID();
        const expiresAt = Date.now() + ttl;

        // mint jwt signed with the room's secret
        const token = jwtSign({ clientId, roomId, exp: expiresAt, data: data ?? {} }, r.roomSecret);

        clients.set(clientId, { clientId, roomId, status: 'reserved', expiresAt, tags: clientTags });

        // build full websocket url with token baked in as query param
        const url = new URL(r.endpoint);
        url.searchParams.set('token', token);

        return { clientId, url: url.toString(), roomId, expiresAt };
    }

    async function connectClient(clientId: string): Promise<void> {
        const c = clients.get(clientId);
        if (c) {
            c.status = 'connected';
            c.expiresAt = 0;
        }
    }

    async function disconnectClient(clientId: string): Promise<void> {
        clients.delete(clientId);
    }

    async function registerServer(options: RegisterServerOptions): Promise<void> {
        validateTags(options.tags);

        // evict previous servers on the same endpoint (handles restarts)
        for (const [id, s] of servers) {
            if (s.endpoint === options.endpoint && id !== options.serverId) {
                // delete rooms for the stale server
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

    async function heartbeat(serverId: string): Promise<void> {
        const s = servers.get(serverId);
        if (s) s.lastHeartbeat = Date.now();
    }

    async function unregisterServer(serverId: string): Promise<void> {
        // delete all rooms for this server
        for (const [roomId, r] of rooms) {
            if (r.serverId === serverId) {
                deleteClientsForRoom(roomId);
                rooms.delete(roomId);
            }
        }
        servers.delete(serverId);
    }

    async function addServerTags(serverId: string, tags: Record<string, string>): Promise<void> {
        const s = servers.get(serverId);
        if (!s) throw new ServerNotFoundError(serverId);
        validateTags(tags);
        Object.assign(s.tags, tags);
    }

    async function removeServerTags(serverId: string, keys: string[]): Promise<void> {
        const s = servers.get(serverId);
        if (!s) throw new ServerNotFoundError(serverId);
        for (const key of keys) delete s.tags[key];
    }

    async function listServers(filter?: ListServersFilter): Promise<ServerInfo[]> {
        const cutoff = Date.now() - STALE_MS;
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

    async function listStaleServers(): Promise<ServerInfo[]> {
        const cutoff = Date.now() - STALE_MS;
        const result: ServerInfo[] = [];
        for (const s of servers.values()) {
            if (s.lastHeartbeat < cutoff) result.push(serverToInfo(s));
        }
        return result;
    }

    async function getServer(serverId: string): Promise<ServerInfo | null> {
        const s = servers.get(serverId);
        return s ? serverToInfo(s) : null;
    }

    async function subscribeRoomAssignments(serverId: string, callback: (room: DesiredRoom) => void): Promise<() => void> {
        const listener = (room: DesiredRoom) => callback(room);
        events.on(`room-assigned:${serverId}`, listener);
        return () => {
            events.removeListener(`room-assigned:${serverId}`, listener);
        };
    }

    async function tryAcquireLeader(): Promise<boolean> {
        return true;
    }

    async function renewLeader(): Promise<boolean> {
        return true;
    }

    async function releaseLeader(): Promise<void> {}

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
