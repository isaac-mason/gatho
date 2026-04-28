import { jwtSign } from '../common/jwt';
import { log } from '../common/logger';
import {
    DriverConfigError,
    RoomNotFoundError,
    RoomNotRunningError,
    RoomStartError,
    RoomTimeoutError,
    ServerNotFoundError,
} from './errors';
import type { Fragment, Sql } from 'postgres';
import postgres from 'postgres';
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
import { validateTags } from './types';

/**
 * postgres driver implementation using porsager/postgres
 * multi-server production driver backed by postgresql
 * uses UNLOGGED tables (ephemeral data, no WAL overhead),
 * LISTEN/NOTIFY for waitForRoom, and row-level leader election.
 */
export async function createPostgresDriver(options: PostgresDriverOptions = {}): Promise<Driver> {
    const db = options.sql ?? postgres(options.url ?? process.env.GATHO_POSTGRES_URL ?? 'postgresql://localhost:5432/gatho');
    const t = createTableNames(options.schema ?? 'gatho');
    await ensureSchemaWithRetry(db, t);

    // helper: get clients for a room
    async function getClientsForRoom(db: Sql, roomId: string): Promise<ClientInfo[]> {
        const rows = await db<{ client_id: string; status: string; tags: Record<string, string> }[]>`
            select client_id, status, tags from ${db.unsafe(t.clients)}
            where room_id = ${roomId}
        `;
        return rows.map((r) => ({
            clientId: r.client_id,
            status: r.status as ClientInfo['status'],
            tags: r.tags,
        }));
    }

    // helper: build RoomInfo from a row
    async function rowToRoomInfo(db: Sql, r: RoomRow): Promise<RoomInfo> {
        return {
            roomId: r.room_id,
            roomType: r.room_type,
            serverId: r.server_id,
            status: r.status as RoomStatus,
            endpoint: r.endpoint,
            clients: await getClientsForRoom(db, r.room_id),
            data: r.data as RoomData,
            tags: r.tags,
            createdAt: Number(r.created_at),
        };
    }

    // helper: get rooms for a server
    async function getRoomsForServer(db: Sql, serverId: string): Promise<RoomInfo[]> {
        const rows = await db<RoomRow[]>`
            select room_id, room_type, server_id, status, endpoint, data, tags, created_at
            from ${db.unsafe(t.rooms)} where server_id = ${serverId}
        `;
        return Promise.all(rows.map((r) => rowToRoomInfo(db, r)));
    }

    // helper: build ServerInfo from a row
    async function rowToServerInfo(db: Sql, r: ServerRow): Promise<ServerInfo> {
        return {
            serverId: r.server_id,
            endpoint: r.endpoint,
            lastHeartbeat: Number(r.last_heartbeat),
            rooms: await getRoomsForServer(db, r.server_id),
            tags: r.tags,
            roomTypes: r.room_types,
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
        const servers = await db`
            select 1 from ${db.unsafe(t.servers)} where server_id = ${serverId} limit 1
        `;
        if (servers.length === 0) throw new ServerNotFoundError(serverId);

        const now = Date.now();
        await db`
            insert into ${db.unsafe(t.rooms)} (room_id, room_type, server_id, status, data, tags, created_at)
            values (${roomId}, ${roomType}, ${serverId}, 'requested', ${JSON.stringify(data)}::jsonb, ${JSON.stringify(tags)}::jsonb, ${now})
        `;

        // notify the server immediately — no waiting for reconciler poll.
        // note: pg_notify payloads are limited to ~8000 bytes. RoomData
        // should stay small (it's Record<string, string|number|boolean>).
        // if the payload exceeds the limit, pg will throw and the sdk-side
        // waitForRoom timeout + retry handles the missed notification.
        const payload = JSON.stringify({ roomId, roomType, data });
        await db`select pg_notify(${t.schema + ':room-assigned:' + serverId}, ${payload})`;
    }

    async function unregisterRoom(roomId: string): Promise<void> {
        // cascade deletes clients via FK
        await db`delete from ${db.unsafe(t.rooms)} where room_id = ${roomId}`;
    }

    async function roomReady(roomId: string, endpoint: string, roomSecret: string): Promise<void> {
        await db`
            update ${db.unsafe(t.rooms)}
            set status = 'running', endpoint = ${endpoint}, room_secret = ${roomSecret}
            where room_id = ${roomId}
        `;
        // notify waiters via NOTIFY
        await db`select pg_notify(${t.schema + ':room-ready:' + roomId}, ${roomId})`;
    }

    async function roomFailure(roomId: string, _reason: string): Promise<void> {
        await unregisterRoom(roomId);
    }

    async function waitForRoom(roomId: string, timeoutMs: number): Promise<RoomInfo> {
        // check if already running
        const existing = await getRoomInfo(roomId);
        if (existing && existing.status === 'running') return existing;

        return new Promise<RoomInfo>((resolve, reject) => {
            let settled = false;
            const channel = t.schema + ':room-ready:' + roomId;

            const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                // unlisten is fire-and-forget
                listenHandle.then((h) => h.unlisten()).catch(() => {});
            };

            const timer = setTimeout(() => {
                cleanup();
                reject(new RoomTimeoutError(roomId, timeoutMs));
            }, timeoutMs);

            const listenHandle = db.listen(channel, (_payload) => {
                cleanup();
                getRoomInfo(roomId)
                    .then((info) => {
                        if (info) {
                            resolve(info);
                        } else {
                            reject(new RoomStartError(roomId));
                        }
                    })
                    .catch(reject);
            });

            // handle listen errors
            listenHandle.catch((err) => {
                cleanup();
                reject(err);
            });

            // re-check after subscribing in case we missed it
            listenHandle
                .then(() => {
                    if (settled) return;
                    getRoomInfo(roomId)
                        .then((info) => {
                            if (info && info.status === 'running' && !settled) {
                                cleanup();
                                resolve(info);
                            }
                        })
                        .catch(() => {});
                })
                .catch(() => {});
        });
    }

    async function getRoomInfo(roomId: string): Promise<RoomInfo | null> {
        const rows = await db<RoomRow[]>`
            select room_id, room_type, server_id, status, endpoint, data, tags, created_at
            from ${db.unsafe(t.rooms)} where room_id = ${roomId}
        `;
        if (rows.length === 0) return null;
        return rowToRoomInfo(db, rows[0]);
    }

    async function listRooms(filter?: ListRoomsFilter): Promise<RoomInfo[]> {
        // build dynamic WHERE conditions
        const conditions: Fragment[] = [];

        if (filter?.type) {
            conditions.push(db`room_type = ${filter.type}`);
        }
        if (filter?.status) {
            conditions.push(db`status = ${filter.status}`);
        }
        if (filter?.serverId) {
            conditions.push(db`server_id = ${filter.serverId}`);
        }
        conditions.push(...buildTagFilters(db, filter?.tags, 'tags'));

        const where =
            conditions.length > 0
                ? db`where ${conditions.reduce((acc, cond, i) => (i === 0 ? cond : db`${acc} and ${cond}`))}`
                : db``;

        const rows = await db<RoomRow[]>`
            select room_id, room_type, server_id, status, endpoint, data, tags, created_at
            from ${db.unsafe(t.rooms)} ${where}
        `;

        return Promise.all(rows.map((r) => rowToRoomInfo(db, r)));
    }

    async function addRoomTags(roomId: string, tags: Record<string, string>): Promise<void> {
        validateTags(tags);

        // jsonb || jsonb merges, with right side winning on conflicts
        const result = await db`
            update ${db.unsafe(t.rooms)}
            set tags = tags || ${JSON.stringify(tags)}::jsonb
            where room_id = ${roomId}
        `;
        if (result.count === 0) throw new RoomNotFoundError(roomId);
    }

    async function removeRoomTags(roomId: string, tagKeys: string[]): Promise<void> {
        if (tagKeys.length === 0) return;

        // remove multiple keys from jsonb in a single statement
        const result = await db`
            update ${db.unsafe(t.rooms)}
            set tags = tags - ${db.array(tagKeys)}::text[]
            where room_id = ${roomId}
        `;
        if (result.count === 0) throw new RoomNotFoundError(roomId);
    }

    async function reserveClient(
        roomId: string,
        ttl: number,
        data?: Record<string, unknown>,
        tags?: Record<string, string>,
    ): Promise<ClientReservation> {
        const rooms = await db<{ room_id: string; status: string; room_secret: string | null; endpoint: string | null }[]>`
            select room_id, status, room_secret, endpoint
            from ${db.unsafe(t.rooms)} where room_id = ${roomId}
        `;
        if (rooms.length === 0) throw new RoomNotFoundError(roomId);
        const room = rooms[0];
        if (room.status !== 'running' || !room.room_secret || !room.endpoint) throw new RoomNotRunningError(roomId);

        const clientTags = tags ?? {};
        validateTags(clientTags);

        const clientId = crypto.randomUUID();
        const expiresAt = Date.now() + ttl;

        const token = jwtSign({ clientId, roomId, exp: expiresAt, data: data ?? {} }, room.room_secret);

        await db`
            insert into ${db.unsafe(t.clients)} (client_id, room_id, status, expires_at, tags)
            values (${clientId}, ${roomId}, 'reserved', ${expiresAt}, ${db.json(clientTags)})
        `;

        const url = new URL(room.endpoint);
        url.searchParams.set('token', token);

        return { clientId, url: url.toString(), roomId, expiresAt };
    }

    async function connectClient(clientId: string): Promise<void> {
        await db`
            update ${db.unsafe(t.clients)}
            set status = 'connected', expires_at = 0
            where client_id = ${clientId}
        `;
    }

    async function disconnectClient(clientId: string): Promise<void> {
        await db`delete from ${db.unsafe(t.clients)} where client_id = ${clientId}`;
    }

    // heartbeat doubles as registration. on first call (no row for this serverId)
    // we validate tags and evict any prior server bound to the same endpoint —
    // handles restart-with-fresh-id. the upsert below intentionally omits `tags`
    // from the update list so subsequent heartbeats don't clobber tag mutations
    // from addServerTags/removeServerTags. returns the post-write authoritative
    // tag state and the rooms currently assigned to this server, so the caller's
    // control loop can reconcile in the same round-trip.
    async function heartbeat(opts: HeartbeatOptions): Promise<HeartbeatResult> {
        const existing = await db`
            select 1 from ${db.unsafe(t.servers)} where server_id = ${opts.serverId} limit 1
        `;
        const registered = existing.length === 0;
        if (registered) {
            validateTags(opts.tags);
            await db`
                delete from ${db.unsafe(t.servers)}
                where endpoint = ${opts.endpoint} and server_id != ${opts.serverId}
            `;
        }

        const now = Date.now();
        const upserted = await db<{ tags: Record<string, string> }[]>`
            insert into ${db.unsafe(t.servers)} (server_id, endpoint, tags, room_types, last_heartbeat)
            values (${opts.serverId}, ${opts.endpoint}, ${JSON.stringify(opts.tags)}::jsonb, ${opts.roomTypes}, ${now})
            on conflict (server_id) do update set
                endpoint = excluded.endpoint,
                room_types = excluded.room_types,
                last_heartbeat = excluded.last_heartbeat
            returning tags
        `;
        const tags = upserted[0]?.tags ?? {};

        const desiredRows = await db`
            select room_id, room_type, data
            from ${db.unsafe(t.rooms)} where server_id = ${opts.serverId}
        `;
        const desiredRooms: DesiredRoom[] = desiredRows.map((r) => ({
            roomId: r.room_id as string,
            roomType: r.room_type as string,
            data: r.data as RoomData,
        }));

        return { tags, desiredRooms, registered };
    }

    async function unregisterServer(serverId: string): Promise<void> {
        // cascade deletes rooms -> clients via FK
        await db`delete from ${db.unsafe(t.servers)} where server_id = ${serverId}`;
    }

    async function addServerTags(serverId: string, tags: Record<string, string>): Promise<void> {
        validateTags(tags);

        const result = await db`
            update ${db.unsafe(t.servers)}
            set tags = tags || ${JSON.stringify(tags)}::jsonb
            where server_id = ${serverId}
        `;
        if (result.count === 0) throw new ServerNotFoundError(serverId);
    }

    async function removeServerTags(serverId: string, tagKeys: string[]): Promise<void> {
        if (tagKeys.length === 0) return;

        const result = await db`
            update ${db.unsafe(t.servers)}
            set tags = tags - ${db.array(tagKeys)}::text[]
            where server_id = ${serverId}
        `;
        if (result.count === 0) throw new ServerNotFoundError(serverId);
    }

    async function listServers(filter?: ListServersFilter): Promise<ServerInfo[]> {
        const cutoff = Date.now() - STALE_MS;

        const conditions: Fragment[] = [db`last_heartbeat >= ${cutoff}`];

        if (filter?.roomTypes) {
            // server must support ALL specified room types
            // text[] @> ARRAY[...] checks containment
            conditions.push(db`room_types @> ${filter.roomTypes}`);
        }
        conditions.push(...buildTagFilters(db, filter?.tags, 'tags'));

        const where = db`where ${conditions.reduce((acc, cond, i) => (i === 0 ? cond : db`${acc} and ${cond}`))}`;

        const rows = await db<ServerRow[]>`
            select server_id, endpoint, last_heartbeat, tags, room_types
            from ${db.unsafe(t.servers)} ${where}
        `;

        return Promise.all(rows.map((r) => rowToServerInfo(db, r)));
    }

    async function listStaleServers(): Promise<ServerInfo[]> {
        const cutoff = Date.now() - STALE_MS;
        const rows = await db<ServerRow[]>`
            select server_id, endpoint, last_heartbeat, tags, room_types
            from ${db.unsafe(t.servers)} where last_heartbeat < ${cutoff}
        `;
        return Promise.all(rows.map((r) => rowToServerInfo(db, r)));
    }

    async function getServer(serverId: string): Promise<ServerInfo | null> {
        const rows = await db<ServerRow[]>`
            select server_id, endpoint, last_heartbeat, tags, room_types
            from ${db.unsafe(t.servers)} where server_id = ${serverId}
        `;
        if (rows.length === 0) return null;
        return rowToServerInfo(db, rows[0]);
    }

    async function subscribeRoomAssignments(serverId: string, callback: (room: DesiredRoom) => void): Promise<() => void> {
        const channel = t.schema + ':room-assigned:' + serverId;
        const handle = await db.listen(channel, (payload) => {
            let parsed: DesiredRoom;
            try {
                parsed = JSON.parse(payload) as DesiredRoom;
            } catch {
                console.error('[gatho] malformed room-assigned payload, discarding', { channel, payload });
                return;
            }
            callback(parsed);
        });
        return () => {
            handle.unlisten().catch(() => {});
        };
    }

    // leader election — row-level lock in the leader table.
    // tryAcquireLeader inserts if empty or takes over if expired.
    // renewLeader extends the lock if we still own it.
    // releaseLeader deletes our row.

    async function tryAcquireLeader(serverId: string): Promise<boolean> {
        const now = Date.now();

        // try to insert (empty table) or take over expired lock.
        // the ON CONFLICT WHERE clause references the existing row via
        // the schema-qualified table name for unambiguous column access.
        const result = await db`
            insert into ${db.unsafe(t.leader)} (id, server_id, renewed_at)
            values (1, ${serverId}, ${now})
            on conflict (id) do update set
                server_id = ${serverId},
                renewed_at = ${now}
            where ${db.unsafe(t.leader)}.server_id = ${serverId}
               or ${db.unsafe(t.leader)}.renewed_at < ${now - LEADER_LOCK_TTL_MS}
        `;
        return result.count > 0;
    }

    async function renewLeader(serverId: string): Promise<boolean> {
        const now = Date.now();
        const result = await db`
            update ${db.unsafe(t.leader)}
            set renewed_at = ${now}
            where id = 1 and server_id = ${serverId}
        `;
        return result.count > 0;
    }

    async function releaseLeader(serverId: string): Promise<void> {
        await db`
            delete from ${db.unsafe(t.leader)}
            where id = 1 and server_id = ${serverId}
        `;
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

// row shapes for typed queries
type RoomRow = {
    room_id: string;
    room_type: string;
    server_id: string;
    status: string;
    endpoint: string | null;
    data: Record<string, unknown>;
    tags: Record<string, string>;
    created_at: string;
};

type ServerRow = {
    server_id: string;
    endpoint: string;
    last_heartbeat: string;
    tags: Record<string, string>;
    room_types: string[];
};

// bump this when the schema changes. on mismatch the driver drops and
// recreates all gatho tables — all data is ephemeral, no migration needed.
const SCHEMA_VERSION = 2;

// hardcoded staleness threshold — servers older than this are considered dead
const STALE_MS = 30_000;

// leader lock ttl — if not renewed within this window, another server can take over
const LEADER_LOCK_TTL_MS = 30_000;

/** options for creating a postgres driver */
export type PostgresDriverOptions = {
    /**
     * an existing postgres.js sql instance.
     * if provided, url is ignored.
     */
    sql?: Sql;
    /**
     * postgres connection url, defaults to $GATHO_POSTGRES_URL or postgresql://localhost:5432/gatho.
     * ignored if sql is provided.
     */
    url?: string;
    /**
     * postgres schema name used to namespace all gatho tables.
     * defaults to "gatho". analogous to the redis driver's `prefix` option.
     */
    schema?: string;
};

// pre-built sql.unsafe fragments for schema-qualified table names.
// created once at driver init, zero per-query overhead.
type SchemaTable = {
    // the bare schema identifier, for CREATE/DROP SCHEMA
    schema: string;
    // schema-qualified table names
    servers: string;
    rooms: string;
    clients: string;
    leader: string;
    // schema_version lives in public, but its name includes the schema
    // so multiple deployments sharing a database don't collide.
    schemaVersion: string;
};

function createTableNames(schema: string): SchemaTable {
    // reject schema names that would break identifier quoting.
    // pg identifiers can contain letters, digits, underscores — we allow
    // hyphens too since they're common in deployment names.
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(schema)) {
        throw new DriverConfigError(`invalid postgres schema name: ${JSON.stringify(schema)}`);
    }
    return {
        schema,
        servers: `"${schema}".servers`,
        rooms: `"${schema}".rooms`,
        clients: `"${schema}".clients`,
        leader: `"${schema}".leader`,
        schemaVersion: `public."${schema}_schema_version"`,
    };
}

// retries ensureSchema with exponential backoff until postgres is reachable.
// mirrors ioredis behaviour: the driver factory never rejects just because
// the db isn't up yet — it keeps trying and resolves once the schema is ready.
const SCHEMA_RETRY_BASE_MS = 500;
const SCHEMA_RETRY_MAX_MS = 30_000;
const SCHEMA_RETRY_JITTER_MS = 200;

async function ensureSchemaWithRetry(sql: Sql, t: SchemaTable): Promise<void> {
    let attempt = 0;
    while (true) {
        try {
            await ensureSchema(sql, t);
            if (attempt > 0) {
                log.info('postgres schema ready after retry', { attempts: attempt + 1 });
            }
            return;
        } catch (err) {
            attempt++;
            const backoff = Math.min(SCHEMA_RETRY_BASE_MS * 2 ** (attempt - 1), SCHEMA_RETRY_MAX_MS);
            const jitter = Math.random() * SCHEMA_RETRY_JITTER_MS;
            const delay = backoff + jitter;
            log.warn('postgres not ready, retrying', { attempt, delayMs: Math.round(delay), err });
            await new Promise<void>((r) => setTimeout(r, delay));
        }
    }
}

// schema creation — uses UNLOGGED tables for speed (no WAL writes).
// all gatho state is ephemeral and reconstructed on startup.
// tables live in a dedicated pg schema so we can atomically
// DROP SCHEMA ... CASCADE on version mismatch without tracking
// individual table names across versions.
// the schema_version table lives in public so it survives the drop.
async function ensureSchema(sql: Sql, t: SchemaTable): Promise<void> {
    // schema_version lives in public — must survive DROP SCHEMA CASCADE.
    // regular (logged) table so it persists across unclean pg restarts.
    // single-row enforced by primary key so we never get stale duplicate rows.
    await sql`
        create table if not exists ${sql.unsafe(t.schemaVersion)} (
            id      integer primary key default 1 check (id = 1),
            version integer not null
        )
    `;

    // advisory lock scoped to this transaction prevents concurrent servers racing
    // through migration at the same time. hashtext gives a stable integer key
    // from the schema name so different schemas don't contend with each other.
    // re-check the version inside the lock — another server may have already
    // completed the migration by the time we acquire it.
    await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${t.schema}))`;

        const rows = await tx<{ version: number }[]>`
            select version from ${tx.unsafe(t.schemaVersion)} limit 1
        `;

        if (rows.length > 0 && rows[0].version === SCHEMA_VERSION) return;

        // mismatch or missing — nuke the entire schema and recreate.
        // this is the pg equivalent of redis SCAN+UNLINK — one atomic drop
        // covers every table/index/sequence regardless of what prior versions created.
        // all ddl is inside a transaction so a mid-migration crash leaves no
        // partial state — the version row is only written on full success.
        await tx`drop schema if exists ${tx.unsafe(`"${t.schema}"`)} cascade`;
        await tx`create schema ${tx.unsafe(`"${t.schema}"`)}`;
        await tx`delete from ${tx.unsafe(t.schemaVersion)}`;

        await tx`
            create unlogged table ${tx.unsafe(t.servers)} (
                server_id   text primary key,
                endpoint    text not null,
                tags        jsonb not null default '{}',
                room_types  text[] not null default '{}',
                last_heartbeat bigint not null
            )
        `;

        await tx`
            create unlogged table ${tx.unsafe(t.rooms)} (
                room_id     text primary key,
                room_type   text not null,
                server_id   text not null references ${tx.unsafe(t.servers)}(server_id) on delete cascade,
                status      text not null default 'requested',
                endpoint    text,
                room_secret text,
                data        jsonb not null default '{}',
                tags        jsonb not null default '{}',
                created_at  bigint not null
            )
        `;

        // index for fast lookups by server_id (used by getDesiredState, getRoomsForServer)
        await tx`
            create index on ${tx.unsafe(t.rooms)}(server_id)
        `;

        await tx`
            create unlogged table ${tx.unsafe(t.clients)} (
                client_id   text primary key,
                room_id     text not null references ${tx.unsafe(t.rooms)}(room_id) on delete cascade,
                status      text not null default 'reserved',
                expires_at  bigint not null default 0,
                tags        jsonb not null default '{}'::jsonb
            )
        `;

        // index for fast lookups by room_id (used by getClientsForRoom)
        await tx`
            create index on ${tx.unsafe(t.clients)}(room_id)
        `;

        // leader election table — single row, row-level locking
        await tx`
            create unlogged table ${tx.unsafe(t.leader)} (
                id          integer primary key default 1 check (id = 1),
                server_id   text not null,
                renewed_at  bigint not null
            )
        `;

        await tx`
            insert into ${tx.unsafe(t.schemaVersion)} (version) values (${SCHEMA_VERSION})
            on conflict (id) do update set version = excluded.version
        `;
    });
}

// helper: build a tag containment condition for jsonb @> operator.
// returns an array of sql fragments to AND together.
function buildTagFilters(
    sql: Sql,
    tags: { eq?: Record<string, string>; neq?: Record<string, string> } | undefined,
    column: string,
): Fragment[] {
    const conditions: Fragment[] = [];
    if (!tags) return conditions;

    if (tags.eq) {
        // jsonb @> '{"key":"value"}' — contains check
        for (const [k, v] of Object.entries(tags.eq)) {
            const obj = JSON.stringify({ [k]: v });
            conditions.push(sql`${sql(column)}::jsonb @> ${obj}::jsonb`);
        }
    }
    if (tags.neq) {
        // NOT (jsonb @> '{"key":"value"}')
        for (const [k, v] of Object.entries(tags.neq)) {
            const obj = JSON.stringify({ [k]: v });
            conditions.push(sql`NOT (${sql(column)}::jsonb @> ${obj}::jsonb)`);
        }
    }
    return conditions;
}
