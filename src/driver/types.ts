/** room data - arbitrary key-value pairs passed from sdk to create() hook, persisted in registry
 *  and delivered to workers. keep it small: it is replicated through the driver and pushed on
 *  every room assignment. */
export type RoomData = Record<string, string | number | boolean>;

/** room status — 'requested' until the server confirms the worker is running, then 'running' */
export type RoomStatus = 'requested' | 'running';

/** tag filter — eq matches records where tag key === value, neq matches where tag key !== value.
 *  multiple entries within eq or neq use AND semantics. */
export type TagFilter = {
    /** match records where tag key === value */
    eq?: Record<string, string>;
    /** match records where tag key !== value */
    neq?: Record<string, string>;
};

/** filter for listing rooms */
export type ListRoomsFilter = {
    /** filter by tags */
    tags?: TagFilter;
    /** filter by room type */
    type?: string;
    /** filter by room status */
    status?: RoomStatus;
    /** filter by server id */
    serverId?: string;
};

/** filter for listing servers */
export type ListServersFilter = {
    /** filter by tags */
    tags?: TagFilter;
    /** filter by supported room types — server must support ALL specified types */
    roomTypes?: string[];
};

/** room information */
export type RoomInfo = {
    /** unique identifier for this room */
    roomId: string;

    /** type of the room */
    roomType: string;

    /** which server is running / should run this room */
    serverId: string;

    /** lifecycle status — 'requested' when registered, 'running' once the worker is confirmed ready */
    status: RoomStatus;

    /** client-facing endpoint for this room's ws server (set when status = 'running') */
    endpoint: string | null;

    /** clients associated with this room (reserved + connected) */
    clients: ClientInfo[];

    /** arbitrary data passed at creation time, delivered to create() hook (immutable) */
    data: RoomData;

    /** mutable string key/value tags for userland categorization */
    tags: Record<string, string>;

    /** timestamp when the room was created */
    createdAt: number;
};

/** status of a client */
export type ClientStatus = 'reserved' | 'connected';

/** client information — public shape exposed on RoomInfo.
 *  internal driver records hold additional fields (token, expiresAt, roomId)
 *  that are not exposed here. */
export type ClientInfo = {
    /** unique identifier for this client */
    clientId: string;

    /** current status of the client */
    status: ClientStatus;

    /** immutable string key/value tags set at join time */
    tags: Record<string, string>;

    /** wall-clock ms when the driver first observed this client as connected.
     *  0 while status is 'reserved'. used by the heartbeat reconciler to
     *  distinguish truly-stale clients (connectedAt < heartbeat.timestamp)
     *  from freshly-connected clients that the heartbeat couldn't yet have
     *  seen (connectedAt > heartbeat.timestamp). */
    connectedAt: number;
};

/** client reservation information */
export type ClientReservation = {
    /** unique identifier for this client reservation — used for tracking in the driver and workers, not exposed to users */
    clientId: string;

    /** full websocket url with token baked in as a query param, e.g. "ws://localhost:9001?token=..." — pass directly to connect() */
    url: string;

    /** room identifier this client is connected to */
    roomId: string;

    /** when the reservation expires */
    expiresAt: number;
};

/** server information */
export type ServerInfo = {
    /** unique identifier for this server */
    serverId: string;

    /** full URL for this server's admin HTTP endpoint, e.g. "http://localhost:3000" — used for health checks and ping */
    endpoint: string;

    /** timestamp of the last heartbeat received from this server — used to determine if server is alive or stale */
    lastHeartbeat: number;

    /** rooms currently assigned to this server */
    rooms: RoomInfo[];

    /** string key/value tags for userland metadata (e.g. region, draining status) */
    tags: Record<string, string>;

    /** room types this server can start */
    roomTypes: string[];
};

/** options for a server heartbeat. on first heartbeat (no existing record) the
 *  driver inserts a new server with the supplied identity (endpoint/tags/roomTypes);
 *  on subsequent heartbeats it refreshes lastHeartbeat and updates endpoint/roomTypes,
 *  but `tags` are not overwritten (mutated separately via addServerTags/removeServerTags). */
export type HeartbeatOptions = {
    /** unique identifier for this server */
    serverId: string;
    /** full URL for this server's admin HTTP endpoint, e.g. "http://localhost:3000" */
    endpoint: string;
    /** string key/value tags applied only when the server record is first created. */
    tags: Record<string, string>;
    /** room types this server can start */
    roomTypes: string[];
};

/** room info for reconciler — what this server should be running */
export type DesiredRoom = {
    roomId: string;
    roomType: string;
    data: RoomData;
};

/** authoritative state returned by a heartbeat tick — used by the server's
 *  control loop to refresh its tag cache and reconcile local processes. */
export type HeartbeatResult = {
    /** current tag state for this server (may differ from `options.tags` if
     *  addServerTags/removeServerTags was called since the last heartbeat). */
    tags: Record<string, string>;
    /** rooms currently assigned to this server. */
    desiredRooms: DesiredRoom[];
    /** true if this heartbeat created the server record (no prior row existed).
     *  expected on the first heartbeat from a server process; if the server has
     *  already heartbeat'd before, `registered: true` indicates the record was
     *  reaped while we were alive and we just self-recovered. */
    registered: boolean;
};

/** driver interface — all methods are internal to gatho.
 *  use start() or createGathoSDK() instead of calling these directly. */
export type Driver = {
    /** optional cleanup hook — stops background timers, releases resources.
     *  only relevant for drivers that run background work (e.g. memoryDriver prune interval). */
    destroy?: () => void;

    _internal: {
        /** register a new room */
        registerRoom(
            roomId: string,
            roomType: string,
            serverId: string,
            data: RoomData,
            tags: Record<string, string>,
        ): Promise<void>;

        /** unregister a room */
        unregisterRoom(roomId: string): Promise<void>;

        /** get information about a specific room */
        getRoomInfo(roomId: string): Promise<RoomInfo | null>;

        /** list rooms, optionally filtered by tags/type/status/serverId */
        listRooms(filter?: ListRoomsFilter): Promise<RoomInfo[]>;

        /** add tags to a room */
        addRoomTags(roomId: string, tags: Record<string, string>): Promise<void>;

        /** remove tags from a room */
        removeRoomTags(roomId: string, keys: string[]): Promise<void>;

        /** mark a room as running — called by the server when the worker sends 'ready'.
         *  stores the room's client-facing endpoint and the room secret (used to mint jwts). */
        roomReady(roomId: string, endpoint: string, roomSecret: string): Promise<void>;

        /** report that a room failed (spawn failure, worker crash, stalled heartbeat, etc.) */
        roomFailure(roomId: string, reason: string): Promise<void>;

        /** wait for a room to become 'running'. resolves with RoomInfo once ready,
         *  or rejects if the room doesn't become ready within timeoutMs.
         *  implementations should check initial state (already running) before subscribing. */
        waitForRoom(roomId: string, timeoutMs: number): Promise<RoomInfo>;

        /** allocates a spot for a client, mints a jwt signed with the room's secret.
         *  optional data bag is included in the jwt payload and delivered to onAuth as joinData.
         *  keep data small — the jwt travels in a url query param (~2-3KB practical limit). */
        reserveClient(
            roomId: string,
            ttl: number,
            data?: Record<string, unknown>,
            tags?: Record<string, string>,
        ): Promise<ClientReservation>;

        /** marks a client as connected — called by server when room reports client-connected over ipc.
         *  idempotent upsert: writes the full client record (clientId, roomId, status, tags) regardless
         *  of prior state, so a hash that was evicted between reservation and connection is reconstituted
         *  rather than half-resurrected. tags travel from reserveClient → jwt → room → ipc to reach here. */
        connectClient(clientId: string, roomId: string, tags: Record<string, string>): Promise<void>;

        /** marks a client as disconnected — called by server when room reports client-disconnected over ipc */
        disconnectClient(clientId: string): Promise<void>;

        /** send a heartbeat to indicate this server is alive — should be called at regular intervals (e.g. every 5s).
         *  doubles as registration: the first heartbeat creates the server record; subsequent calls
         *  refresh lastHeartbeat and update endpoint/roomTypes. tags are written only on first insert.
         *  returns the current authoritative tag state and the rooms currently assigned to this server,
         *  so the caller's control loop can reconcile in the same round-trip. */
        heartbeat(options: HeartbeatOptions): Promise<HeartbeatResult>;

        /** unregister a server, e.g. on graceful shutdown */
        unregisterServer(serverId: string): Promise<void>;

        /** add tags to a server */
        addServerTags(serverId: string, tags: Record<string, string>): Promise<void>;

        /** remove tags from a server */
        removeServerTags(serverId: string, keys: string[]): Promise<void>;

        /** list servers with recent heartbeats, optionally filtered by tags/roomTypes */
        listServers(filter?: ListServersFilter): Promise<ServerInfo[]>;

        /** list servers whose heartbeat is older than 30s. internal use only. */
        listStaleServers(): Promise<ServerInfo[]>;

        /** get a single server by id, or null if not found */
        getServer(serverId: string): Promise<ServerInfo | null>;

        /** subscribe to room assignment notifications for a server.
         *  callback fires when a new room is assigned to this server.
         *  returns an unsubscribe function. */
        subscribeRoomAssignments(serverId: string, callback: (room: DesiredRoom) => void): Promise<() => void>;

        /** attempt to acquire the leader lock. returns true if this server is now the leader. */
        tryAcquireLeader(serverId: string): Promise<boolean>;

        /** renew the leader lock. returns true if renewal succeeded (we're still leader). */
        renewLeader(serverId: string): Promise<boolean>;

        /** release the leader lock if we own it. */
        releaseLeader(serverId: string): Promise<void>;
    };
};

// --- tag validation ---

import { InvalidTagError, PayloadTooLargeError } from './errors';

const VALID_TAG_RE = /^[a-zA-Z0-9_-]+$/;

/** validate a tag key — must be alphanumeric/hyphen/underscore, must not start with _ (reserved for internal use) */
export function validateTagKey(key: string): void {
    if (!VALID_TAG_RE.test(key)) {
        throw new InvalidTagError(`invalid tag key "${key}" — must match [a-zA-Z0-9_-]+`);
    }
    if (key.startsWith('_')) {
        throw new InvalidTagError(`tag key "${key}" is reserved (starts with _)`);
    }
}

/** validate a tag value — must be alphanumeric/hyphen/underscore */
export function validateTagValue(value: string): void {
    if (!VALID_TAG_RE.test(value)) {
        throw new InvalidTagError(`invalid tag value "${value}" — must match [a-zA-Z0-9_-]+`);
    }
}

/** validate all keys and values in a tags record */
export function validateTags(tags: Record<string, string>): void {
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
export const RESERVE_DATA_MAX_BYTES = 2048;

/** maximum serialized size of the driver-internal `tags` record on a reservation jwt. */
export const RESERVE_TAGS_MAX_BYTES = 512;

/** validate that `data` will fit in the reservation jwt without blowing url limits. */
export function validateReserveData(data: unknown): void {
    const size = Buffer.byteLength(JSON.stringify(data ?? {}));
    if (size > RESERVE_DATA_MAX_BYTES) {
        throw new PayloadTooLargeError('data', size, RESERVE_DATA_MAX_BYTES);
    }
}

/** validate that `tags` will fit in the reservation jwt without blowing url limits. */
export function validateReserveTagsSize(tags: Record<string, string>): void {
    const size = Buffer.byteLength(JSON.stringify(tags));
    if (size > RESERVE_TAGS_MAX_BYTES) {
        throw new PayloadTooLargeError('tags', size, RESERVE_TAGS_MAX_BYTES);
    }
}
