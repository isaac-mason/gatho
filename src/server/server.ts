// start - main entry point for gatho server
// uses reconciliation loop for room spawning.
// rooms run their own websocket servers — clients connect directly.
// this process is control-plane only: health checks, reconciliation, leader election.
//
// the server core does NOT own the notify channel — the runner does. spawn hands
// the runner its message handler and exit sink (ctx.onMessage, ctx.stopped); how
// the room's messages reach them (uds frames, tcp, in-memory) is the runner's business.
// messages flow one direction: room → server.

import { randomBytes, randomUUID } from 'crypto';
import * as http from 'http';
import type { Socket } from 'net';
import { log } from '../common/logger';
import type { NotifyMessage } from '../common/notify-protocol';
import { type Punctuator, punctuate } from '../common/punctuate';
import type { Driver, RoomData } from '../driver/types';
import type { RoomRunner } from './runner/types';

/* exported types */

export type RoomEndpointFn = (info: { roomId: string; port: number }) => string;

export type CreateServerOptions = {
    /** map of supported room types to their corresponding RoomRunner */
    rooms: Record<string, RoomRunner>;
    /** driver instance for multi-server communication */
    driver: Driver;
    /** returns the full ws:// or wss:// URL clients will connect to for a room */
    roomEndpoint: RoomEndpointFn;
    /** port to listen on for server HTTP endpoint (health, ping) and driver communication */
    port?: number;
    /** host to listen on for server HTTP endpoint and driver communication */
    host?: string;
    /**
     * cadence of the heartbeat loop (heartbeat + room reconciliation) in milliseconds.
     * note this does not control the timing of room startup, only teardown.
     * @default 5000
     **/
    heartbeatIntervalMs?: number;
    /** tags for this server instance (defaults to `{}`) */
    tags?: Record<string, string>;
    /** timeout for draining rooms in milliseconds */
    drainTimeoutMs?: number;
    /** full URL for this server's HTTP endpoint, e.g. "http://localhost:3000" or "https://us-east.mysite.com".
     *  if not set, defaults to "http://{host}:{port}" using the bound address. */
    serverEndpoint?: string;
    /** how long a freshly spawned room may take to send its first notify message
     *  before startup is considered failed and the room is killed. raise this when
     *  spawning is slow — e.g. a docker runner whose first spawn pulls the image.
     *  @default 30000 */
    roomStartupTimeoutMs?: number;
    /** how long a started room may go without a heartbeat before it is considered
     *  stalled and killed (rooms heartbeat every ~3s). @default 10000 */
    roomStallTimeoutMs?: number;
};

export type RoomDetails = {
    roomId: string;
    roomType: string;
    workerRunning: boolean;
    endpoint: string | null;
    /** the room's lifecycle as the server observes it */
    status: 'starting' | 'ready' | 'stopped';
    /** wall-clock ms of the room's last heartbeat (or first notify message),
     *  null before the room has spoken */
    lastHeartbeatAt: number | null;
};

export type Server = {
    stop(): Promise<void>;
    address(): { host: string; port: number } | null;
    readonly serverId: string;
    getRoomDetails(roomId: string): RoomDetails | null;
    getAllRoomDetails(): RoomDetails[];
};

/* internal types */

type RoomProcess = {
    roomId: string;
    roomType: string;
    roomSecret: string;
    // the immutable creation-time data bag. retained (not dropped after spawn) so
    // reap-recovery can re-register the room's driver record after the record was
    // reaped out from under a still-alive server.
    data: RoomData;
    endpoint: string | null;
    status(): 'starting' | 'ready' | 'stopped';
    kill(): void;
    exited: Promise<void>;
    markExited(): void;
};

// all mutable state + injected dependencies for server functions
type ServerState = {
    options: CreateServerOptions;
    driver: Driver['_internal'];
    runners: Map<string, RoomRunner>;
    port: number;
    host: string;
    serverId: string;
    knownRoomTypes: Set<string>;

    // processes
    processes: Map<string, RoomProcess>;
    lastHeartbeats: Map<string, number>;
    killedRoomIds: Set<string>;
    spawning: Set<string>;
    alive: boolean;

    // network
    openSockets: Set<Socket>;

    // room assignment subscription
    unsubscribeRoomAssignments: (() => void) | null;

    // leader election
    isLeader: boolean;
    leaderPunctuator: Punctuator | null;

    // http
    httpServer: http.Server | null;
    currentAddress: { host: string; port: number } | null;

    // heartbeat loop — single punctuator that drives a heartbeat tick: send a
    // heartbeat (server liveness + first-insert registration) and then reconcile
    // local processes against the desired-rooms set returned by the driver.
    // serverTags caches the authoritative tag state returned from the most recent
    // heartbeat so that if our record gets reaped while we're alive, the next
    // first-insert recovery uses the latest known tags rather than the boot snapshot.
    heartbeatPunctuator: Punctuator | null;
    serverTags: Record<string, string>;
    lastDriverHeartbeatAt: number;
    // true once the first heartbeat has succeeded — used to distinguish initial
    // registration (expected) from reap-recovery (re-registration after we've
    // already been alive, which we warn about).
    previouslyRegistered: boolean;
};

/* constants */

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const LEADER_LOOP_INTERVAL_MS = 10_000;
const LEADER_LOOP_TIMEOUT_MS = 5_000;
const HEARTBEAT_TICK_TIMEOUT_MS = 5_000;

/** default for CreateServerOptions.roomStallTimeoutMs */
const DEFAULT_ROOM_STALL_TIMEOUT_MS = 10_000;

/** default for CreateServerOptions.roomStartupTimeoutMs */
const DEFAULT_ROOM_STARTUP_TIMEOUT_MS = 30_000;

/* centralized room cleanup */

// single cleanup path for a room process. idempotent — no-ops if already cleaned up.
// all teardown paths (process exit, self-stop, heartbeat timeout) go through here
// instead of doing inline cleanup.
type CleanupReason = 'process-exited' | 'self-stopped' | 'heartbeat-timeout';

function cleanupRoom(s: ServerState, roomId: string, reason: CleanupReason): void {
    const proc = s.processes.get(roomId);
    if (!proc) return;

    s.processes.delete(roomId);
    s.lastHeartbeats.delete(roomId);
    proc.markExited();

    log.info('room cleaned up', { roomId, reason });

    switch (reason) {
        case 'self-stopped':
            // room decided to stop — remove from desired state
            s.driver.unregisterRoom(roomId).catch((err) => {
                log.error('failed to unregister room after self-stop', { roomId, err });
            });
            break;
        case 'heartbeat-timeout':
            // process stalled — report failure so driver can reschedule
            s.driver.roomFailure(roomId, 'process stalled (heartbeat timeout)').catch((err) => {
                log.error('failed to report room failure', { roomId, err });
            });
            break;
        case 'process-exited':
            if (s.killedRoomIds.has(roomId)) {
                // expected — server initiated the kill, reconciler handles
                s.killedRoomIds.delete(roomId);
            } else {
                // unexpected crash — report to driver so it's removed from desired state
                s.driver.roomFailure(roomId, `unexpected ${reason}`).catch((err) => {
                    log.error('failed to report room failure', { roomId, err });
                });
            }
            break;
    }
}

/* ipc message handling */

// reconcile driver client state against the room's ground truth (from heartbeat).
// the room's client list is authoritative — if a fast-path connect/disconnect
// message was lost (e.g. transient driver error), this corrects the drift.
// each entry carries the tags forwarded from the reservation jwt so we can
// pass them to driver.connectClient — required for an upsert that doesn't
// half-resurrect an evicted record.
//
// heartbeatTimestamp is the wall-clock at which the room captured `roomClients`.
// the disconnect path gates on `driver.connectedAt < heartbeatTimestamp` so a
// client that connected after the snapshot was captured (and therefore couldn't
// possibly appear in `roomClients`) isn't mistaken for stale state and removed.
// without that gate, the heartbeat handler races client-connected ipc: under
// load the room admits a client between snapshot capture and heartbeat arrival,
// the driver writes it as connected before the reconciler reads, and the
// reconciler then disconnects a live peer.
export async function reconcileClients(
    driver: Driver['_internal'],
    roomId: string,
    roomClients: { clientId: string; tags: Record<string, string> }[],
    heartbeatTimestamp: number,
): Promise<void> {
    const roomInfo = await driver.getRoomInfo(roomId);
    if (!roomInfo) return; // room already gone

    const roomSet = new Set(roomClients.map((c) => c.clientId));

    // clients the room says are connected but the driver doesn't have as 'connected'
    for (const { clientId, tags } of roomClients) {
        const driverClient = roomInfo.clients.find((c) => c.clientId === clientId);
        if (!driverClient || driverClient.status !== 'connected') {
            log.info('reconcile: connecting client missing from driver', { roomId, clientId });
            await driver.connectClient(clientId, roomId, tags).catch((err) => {
                log.error('reconcile: failed to connect client', { roomId, clientId, err });
            });
        }
    }

    // clients the driver thinks are connected but the room doesn't have.
    // skip clients whose connectedAt is after the heartbeat snapshot — the room
    // couldn't have known about them yet, so absence is not evidence of staleness.
    for (const driverClient of roomInfo.clients) {
        if (
            driverClient.status === 'connected' &&
            !roomSet.has(driverClient.clientId) &&
            driverClient.connectedAt < heartbeatTimestamp
        ) {
            log.info('reconcile: disconnecting stale client from driver', { roomId, clientId: driverClient.clientId });
            await driver.disconnectClient(driverClient.clientId).catch((err) => {
                log.error('reconcile: failed to disconnect client', { roomId, clientId: driverClient.clientId, err });
            });
        }
    }
}

// handle all notify messages from a room.
// single dispatch point — every room→server message type is handled here.
function handleNotifyMessage(s: ServerState, roomId: string, msg: NotifyMessage): void {
    switch (msg.type) {
        case 'heartbeat': {
            s.lastHeartbeats.set(roomId, Date.now());

            const proc = s.processes.get(roomId);
            log.debug('room heartbeat', {
                roomId,
                roomType: proc?.roomType,
                memoryRss: msg.metrics?.memoryRss,
                memoryHeapUsed: msg.metrics?.memoryHeapUsed,
                cpuUser: msg.metrics?.cpuUser,
                cpuSystem: msg.metrics?.cpuSystem,
                clientCount: msg.clients.length,
            });

            // reconcile client state in the background — don't block the heartbeat path
            reconcileClients(s.driver, roomId, msg.clients, msg.timestamp).catch((err) => {
                log.error('client reconciliation failed', { roomId, err });
            });
            break;
        }
        case 'ready': {
            const proc = s.processes.get(roomId);
            if (!proc) {
                log.error('received ready for unknown room', { roomId });
                break;
            }

            const endpoint = s.options.roomEndpoint({ roomId, port: msg.port });
            proc.endpoint = endpoint;

            s.driver.roomReady(roomId, endpoint, proc.roomSecret).catch((err) => {
                log.error('failed to mark room as ready', { roomId, err });
            });

            log.info('room ready', { roomId, roomType: proc.roomType, wsPort: msg.port, endpoint });
            break;
        }
        case 'client-connected': {
            s.driver.connectClient(msg.clientId, msg.roomId, msg.tags).catch((err) => {
                log.error('failed to connect client in driver', { roomId, clientId: msg.clientId, err });
            });
            break;
        }
        case 'client-disconnected': {
            s.driver.disconnectClient(msg.clientId).catch((err) => {
                log.error('failed to disconnect client in driver', { roomId, clientId: msg.clientId, err });
            });
            break;
        }
        case 'stopped': {
            cleanupRoom(s, roomId, 'self-stopped');
            break;
        }
        case 'error': {
            log.error('room error', { roomId, message: msg.message });
            break;
        }
    }
}

/* room lifecycle */

// spawn a new room via the injected runner.
// 1. registers the room process handle, then calls runner.spawn() with two
//    injected sinks: `notifier` (room→server notify messages, however the runner
//    chooses to carry them) and `stopped` (the runner's observation that the
//    room exited).
// 2. waits for the room's first notify message before resolving — a room that
//    exits or stays silent past the startup timeout is a spawn failure.
// 3. when the room sends 'ready' with its ws port, computes the endpoint and
//    registers with the driver.
async function createRoom(s: ServerState, roomId: string, roomType: string, data: RoomData): Promise<RoomProcess> {
    const runner = s.runners.get(roomType);
    if (!runner) {
        throw new Error(`no runner for room type "${roomType}"`);
    }

    const roomSecret = randomBytes(32).toString('base64url');

    let resolveExited: () => void;
    const exited = new Promise<void>((r) => {
        resolveExited = r;
    });

    // startup gate: resolves on the room's first notify message, rejects if the
    // room exits (or stays silent past the timeout) before ever speaking.
    let started = false;
    let stoppedCalled = false;
    let status: 'starting' | 'ready' | 'stopped' = 'starting';

    const roomProcess: RoomProcess = {
        roomId,
        roomType,
        roomSecret,
        data,
        endpoint: null,
        status: () => status,
        kill: () => {},
        exited,
        markExited: () => resolveExited(),
    };

    // register before spawn — the room's first notify message (often `ready`)
    // must find the process entry in place. note: lastHeartbeats is NOT seeded
    // here — the stall sweep must not tick against a room that hasn't spoken
    // yet, or it would cut the startup budget down to the stall timeout.
    // the clock starts on the first notify message.
    s.processes.set(roomId, roomProcess);
    let settleStarted!: { resolve: () => void; reject: (err: Error) => void };
    const startedPromise = new Promise<void>((resolve, reject) => {
        settleStarted = { resolve, reject };
    });

    const onMessage = (msg: NotifyMessage): void => {
        // drop messages once the room has exited or been cleaned up — a late
        // heartbeat must not resurrect bookkeeping for a dead room.
        if (stoppedCalled || !s.processes.has(roomId)) return;
        if (!started) {
            started = true;
            s.lastHeartbeats.set(roomId, Date.now());
            settleStarted.resolve();
        }
        if (msg.type === 'ready' && status === 'starting') status = 'ready';
        if (msg.type === 'stopped') status = 'stopped';
        handleNotifyMessage(s, roomId, msg);
    };

    function stopped(code: number | null): void {
        if (stoppedCalled) return;
        stoppedCalled = true;
        status = 'stopped';
        if (!started) {
            settleStarted.reject(new Error(`room process exited during startup (code ${code})`));
        } else {
            cleanupRoom(s, roomId, 'process-exited');
        }
    }

    const spawnResult = runner.spawn({
        roomId,
        roomType,
        serverId: s.serverId,
        roomSecret,
        data,
        onMessage,
        stopped,
        status: () => status,
    });

    roomProcess.kill = () => spawnResult.kill();

    const startupTimeoutMs = s.options.roomStartupTimeoutMs ?? DEFAULT_ROOM_STARTUP_TIMEOUT_MS;
    const startupTimeout = setTimeout(() => {
        settleStarted.reject(new Error(`room sent no notify message within ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);
    startupTimeout.unref();

    try {
        await startedPromise;
    } catch (err) {
        // startup failed — unregister and make sure nothing lingers. on the
        // timeout path the room may still be running; kill() is a no-op for a
        // room that already exited.
        s.processes.delete(roomId);
        s.lastHeartbeats.delete(roomId);
        spawnResult.kill();
        roomProcess.markExited();
        throw err;
    } finally {
        clearTimeout(startupTimeout);
    }

    return roomProcess;
}

// kill a room process. the runner's kill() handles signal escalation
// (e.g. SIGTERM then SIGKILL). cleanup happens via the onExit handler
// which calls cleanupRoom.
function destroyWorker(s: ServerState, roomId: string): void {
    const roomProcess = s.processes.get(roomId);
    if (!roomProcess) return;

    s.killedRoomIds.add(roomId);
    roomProcess.kill();
}

function shutdownAllWorkers(s: ServerState): void {
    for (const roomId of Array.from(s.processes.keys())) {
        destroyWorker(s, roomId);
    }
}

/* heartbeat monitoring */

// sweep all process heartbeats — called at the top of each reconcile tick.
// kills stalled processes and reports failure to the driver.
function checkHeartbeats(s: ServerState): void {
    const now = Date.now();
    const stallTimeoutMs = s.options.roomStallTimeoutMs ?? DEFAULT_ROOM_STALL_TIMEOUT_MS;
    for (const [roomId, lastBeat] of s.lastHeartbeats) {
        if (now - lastBeat > stallTimeoutMs) {
            const roomProcess = s.processes.get(roomId);
            if (roomProcess) {
                log.warn('process stalled, killing', { roomId, stalledMs: now - lastBeat });
                // add to killedRoomIds so the subsequent process-exited event
                // doesn't double-report — heartbeat-timeout already calls roomFailure
                s.killedRoomIds.add(roomId);
                roomProcess.kill();
                cleanupRoom(s, roomId, 'heartbeat-timeout');
            }
        }
    }
}

/* push-based room spawning */

async function startRoomSubscription(s: ServerState): Promise<void> {
    s.unsubscribeRoomAssignments = await s.driver.subscribeRoomAssignments(s.serverId, (room) => {
        if (s.processes.has(room.roomId)) return;
        if (s.spawning.has(room.roomId)) return;
        if (!s.alive) return;

        s.spawning.add(room.roomId);
        createRoom(s, room.roomId, room.roomType, room.data)
            .catch((err) => {
                const reason = err instanceof Error ? err.message : String(err);
                log.error('room failed to start', { roomId: room.roomId, reason });
                s.driver.roomFailure(room.roomId, reason).catch((e) => {
                    log.error('failed to report room failure', { roomId: room.roomId, err: e });
                });
            })
            .finally(() => {
                s.spawning.delete(room.roomId);
            });
    });
}

function stopRoomSubscription(s: ServerState): void {
    if (s.unsubscribeRoomAssignments) {
        s.unsubscribeRoomAssignments();
        s.unsubscribeRoomAssignments = null;
    }
}

/* heartbeat loop — heartbeat + room reconciliation in one tick */

// every tick: send a heartbeat (which doubles as registration if our record was
// reaped), refresh the cached tag state from what the driver returns, sweep local
// process heartbeats, and kill any rooms that are no longer in the desired set
// returned by the heartbeat. push-based subscribeRoomAssignments handles new
// assignments instantly; this loop is the safety net for missed pushes plus the
// authoritative source for "which rooms should this server be running right now".
async function heartbeatTick(s: ServerState, adminEndpoint: string, isCurrent: () => boolean): Promise<void> {
    const result = await s.driver.heartbeat({
        serverId: s.serverId,
        endpoint: adminEndpoint,
        tags: s.serverTags,
        roomTypes: Array.from(s.knownRoomTypes),
    });

    // the heartbeat round-trip may have outlived this tick's timeout: a fresh
    // tick is already reconciling against newer state. discard our now-stale
    // conclusions rather than writing them back and destroying rooms the newer
    // tick's desired-set still wants.
    if (!isCurrent()) {
        log.warn('discarding stale heartbeat tick result', { serverId: s.serverId });
        return;
    }

    s.serverTags = result.tags;
    s.lastDriverHeartbeatAt = Date.now();

    checkHeartbeats(s);

    const desiredIds = new Set(result.desiredRooms.map((r) => r.roomId));

    // reap-recovery: our server record was reaped (e.g. a driver blip stalled our
    // heartbeats past the staleness threshold) while we were still alive and
    // running rooms. this heartbeat re-created the record (registered: true) but
    // it comes back with an EMPTY desired-set — reaping the server also deleted
    // its room records. without intervention the destroy sweep below would kill
    // every healthy, client-occupied room. instead, re-assert our still-running
    // local rooms into the driver BEFORE the sweep so they survive.
    const reasserted = new Set<string>();
    if (result.registered && s.previouslyRegistered) {
        const restoredRoomIds: string[] = [];
        for (const proc of s.processes.values()) {
            // only re-assert rooms that are actually ready and NOT already in the
            // driver's desired set. a room still present in desiredRooms doesn't
            // need re-asserting (its record survived). checking desiredRooms also
            // guards against fighting a deliberate destroy: if an sdk destroyed a
            // room during the outage, registerRoom would recreate it — but a
            // destroyed room won't be in our processes-with-ready-status set for
            // long, and more importantly we accept the tradeoff that a deliberate
            // sdk destroy landing DURING the outage gets re-asserted here and then
            // re-destroyed on the next reconcile after the sdk retries. that window
            // is bounded by one heartbeat interval and never resurrects a room the
            // sdk has finished tearing down before the reap.
            if (proc.status() !== 'ready') continue;
            if (desiredIds.has(proc.roomId)) continue;
            if (!proc.endpoint) continue;

            // note: room tags from the original sdk.createRoom are NOT persisted
            // on the RoomProcess, so they cannot be restored here — re-register
            // with empty tags. building tag persistence is out of scope; we warn.
            try {
                await s.driver.registerRoom(proc.roomId, proc.roomType, s.serverId, proc.data, {});
                await s.driver.roomReady(proc.roomId, proc.endpoint, proc.roomSecret);
                reasserted.add(proc.roomId);
                restoredRoomIds.push(proc.roomId);
            } catch (err) {
                log.error('failed to re-assert room after server reap', { roomId: proc.roomId, err });
            }
        }

        log.warn('restored missing server entry — record was reaped while alive', {
            serverId: s.serverId,
            tags: s.serverTags,
            restoredRoomIds,
            note: 'room tags from the original createRoom were NOT restored (not persisted on the server)',
        });
    }

    s.previouslyRegistered = true;

    // destroy sweep: kill any local room no longer wanted by the driver. skip the
    // rooms we just re-asserted this tick — the heartbeat's desired-set predates
    // our re-registration and would otherwise cause us to destroy exactly the
    // rooms we just restored.
    for (const roomId of s.processes.keys()) {
        if (reasserted.has(roomId)) continue;
        if (!desiredIds.has(roomId)) {
            destroyWorker(s, roomId);
        }
    }
}

async function startHeartbeatLoop(s: ServerState, adminEndpoint: string, intervalMs: number): Promise<void> {
    if (s.heartbeatPunctuator) return;

    s.heartbeatPunctuator = await punctuate('heartbeat loop', (isCurrent) => heartbeatTick(s, adminEndpoint, isCurrent), {
        intervalMs,
        timeoutMs: HEARTBEAT_TICK_TIMEOUT_MS,
        logger: log.child({ serverId: s.serverId }),
    });
}

function stopHeartbeatLoop(s: ServerState): void {
    if (s.heartbeatPunctuator) {
        s.heartbeatPunctuator.stop();
        s.heartbeatPunctuator = null;
    }
}

/* leader election & duties */

async function reapStaleServers(s: ServerState): Promise<void> {
    const stale = await s.driver.listStaleServers();
    await Promise.all(
        stale.map((server) => {
            log.info('reaping stale server', { staleServerId: server.serverId, endpoint: server.endpoint });
            return s.driver.unregisterServer(server.serverId);
        }),
    );
}

async function cleanOrphanedRoomEntries(s: ServerState): Promise<void> {
    // snapshot servers first, then rooms. a room created after the servers
    // snapshot won't appear in server.rooms, so it can't be falsely flagged
    // as orphaned. the reverse ordering was racy: a room created between
    // listRooms() and listServers() would appear in server.rooms but not
    // in the rooms snapshot, getting incorrectly deleted.
    const servers = await s.driver.listServers();
    const staleServers = await s.driver.listStaleServers();
    const allServers = [...servers, ...staleServers];

    // collect all room ids referenced by servers
    const serverRoomIds = new Set<string>();
    for (const server of allServers) {
        for (const room of server.rooms) {
            serverRoomIds.add(room.roomId);
        }
    }

    // now snapshot rooms — any room in the server list but not in the rooms
    // map is truly orphaned (the room entry was deleted but the server still
    // references it). this direction is safe: rooms created after the servers
    // snapshot aren't in serverRoomIds, so they're never touched.
    const allRooms = await s.driver.listRooms();
    const liveRoomIds = new Set(allRooms.map((r) => r.roomId));

    const orphaned = Array.from(serverRoomIds).filter((id) => !liveRoomIds.has(id));
    await Promise.all(orphaned.map((roomId) => s.driver.unregisterRoom(roomId)));
}

async function runLeaderDuties(s: ServerState): Promise<void> {
    await reapStaleServers(s);
    await cleanOrphanedRoomEntries(s);
}

// single loop covering both election and renewal: branches on s.isLeader.
// errors/timeouts log under 'leader loop error' and retry next tick — we
// don't flip isLeader on driver error because the lock ttl may still be live.
async function startLeaderLoop(s: ServerState): Promise<void> {
    s.leaderPunctuator = await punctuate(
        'leader loop',
        async (isCurrent) => {
            if (s.isLeader) {
                const renewed = await s.driver.renewLeader(s.serverId);
                // a renewal that outlived this tick's timeout must not write
                // leadership state or run duties: a fresh tick is authoritative
                // and may already have re-renewed or dropped leadership. the
                // duties themselves are driver-side idempotent (they only reap
                // genuinely-stale servers / orphaned rooms), but the s.isLeader
                // write and the wasted work are the real hazard here.
                if (!isCurrent()) {
                    log.warn('discarding stale leader renewal result', { serverId: s.serverId });
                    return;
                }
                if (!renewed) {
                    log.warn('lost leadership (renewal failed)', { serverId: s.serverId });
                    s.isLeader = false;
                    return;
                }
                await runLeaderDuties(s);
            } else {
                const acquired = await s.driver.tryAcquireLeader(s.serverId);
                if (!isCurrent()) {
                    log.warn('discarding stale leader acquisition result', { serverId: s.serverId });
                    return;
                }
                if (acquired) {
                    s.isLeader = true;
                    log.info('acquired leadership', { serverId: s.serverId });
                    await runLeaderDuties(s);
                }
            }
        },
        {
            intervalMs: LEADER_LOOP_INTERVAL_MS,
            timeoutMs: LEADER_LOOP_TIMEOUT_MS,
            logger: log.child({ serverId: s.serverId }),
        },
    );
}

function stopLeaderLoop(s: ServerState): void {
    if (s.leaderPunctuator) {
        s.leaderPunctuator.stop();
        s.leaderPunctuator = null;
    }
}

/* http handling */

function handleRequest(_req: http.IncomingMessage, res: http.ServerResponse): void {
    if (_req.url === '/health' && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    if (_req.url === '/ping' && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
        return;
    }

    res.writeHead(404);
    res.end();
}

/* server lifecycle */

async function startInternal(s: ServerState): Promise<void> {
    s.httpServer = http.createServer(handleRequest);

    s.httpServer.on('connection', (socket: Socket) => {
        s.openSockets.add(socket);
        socket.on('close', () => s.openSockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
        s.httpServer!.on('error', reject);
        s.httpServer!.listen(s.port, s.host, () => {
            const addr = s.httpServer!.address();
            if (addr && typeof addr === 'object') {
                s.currentAddress = {
                    host: addr.address,
                    port: addr.port,
                };
            }
            resolve();
        });
    });

    // replace the startup error listener with a persistent one — without this,
    // post-startup http errors (e.g. ECONNRESET) become uncaught EventEmitter errors.
    s.httpServer.removeAllListeners('error');
    s.httpServer.on('error', (err) => {
        log.error('http server error', { err });
    });

    const serverHost = s.currentAddress?.host ?? s.host;
    const serverPort = s.currentAddress?.port ?? s.port;
    const serverEndpoint = s.options.serverEndpoint ?? `http://${serverHost}:${serverPort}`;

    // subscribe to room assignments before the first heartbeat — registering
    // first would let an sdk assign a room before we're listening, dropping the
    // notification. push delivers new assignments instantly; the heartbeat loop
    // is the safety net for missed pushes plus the periodic kill-stale-rooms.
    await startRoomSubscription(s);

    // start the heartbeat loop. punctuate runs the first tick eagerly, so the
    // initial heartbeat (and therefore registration) is awaited before this
    // returns. transient driver failure on the first tick is logged and
    // retried by the loop — startup completes and self-heals in-process.
    await startHeartbeatLoop(s, serverEndpoint, s.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

    await startLeaderLoop(s);
}

async function stop(s: ServerState): Promise<void> {
    s.alive = false;

    // 1. stop room assignment subscription — no new spawns
    stopRoomSubscription(s);

    // 2. stop the heartbeat loop (heartbeat + reconcile)
    stopHeartbeatLoop(s);

    // 3. stop leader loop and release leader lock
    stopLeaderLoop(s);
    if (s.isLeader) {
        await s.driver.releaseLeader(s.serverId);
        s.isLeader = false;
    }

    // 4. unregister server from driver
    await s.driver.unregisterServer(s.serverId);

    // 6. terminate all room processes and wait for them to exit.
    // snapshot exit promises before killing — cleanupRoom deletes entries from s.processes.
    const exitPromises = Array.from(s.processes.values()).map((p) => p.exited);
    shutdownAllWorkers(s);

    if (exitPromises.length > 0) {
        const drainTimeoutMs = s.options.drainTimeoutMs ?? 10_000;
        await Promise.race([Promise.all(exitPromises), new Promise<void>((r) => setTimeout(r, drainTimeoutMs))]);
    }

    // 7. destroy all open sockets and close http server
    for (const socket of s.openSockets) {
        socket.destroy();
    }
    s.openSockets.clear();

    if (s.httpServer) {
        await Promise.race([
            new Promise<void>((resolve) => s.httpServer!.close(() => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
        s.httpServer = null;
    }

    // 8. cleanup
    s.currentAddress = null;
}

/* introspection */

function getRoomDetails(s: ServerState, roomId: string): RoomDetails | null {
    const roomProcess = s.processes.get(roomId);
    if (!roomProcess) return null;

    return {
        roomId,
        roomType: roomProcess.roomType,
        workerRunning: true,
        endpoint: roomProcess.endpoint,
        status: roomProcess.status(),
        lastHeartbeatAt: s.lastHeartbeats.get(roomId) ?? null,
    };
}

function getAllRoomDetails(s: ServerState): RoomDetails[] {
    const details: RoomDetails[] = [];
    for (const roomProcess of s.processes.values()) {
        details.push({
            roomId: roomProcess.roomId,
            roomType: roomProcess.roomType,
            workerRunning: true,
            endpoint: roomProcess.endpoint,
            status: roomProcess.status(),
            lastHeartbeatAt: s.lastHeartbeats.get(roomProcess.roomId) ?? null,
        });
    }
    return details;
}

/* start */

// wildcard hosts don't identify a reachable address. with a networked driver the
// bind host becomes the published serverEndpoint, so a wildcard means every server
// registers the same unroutable endpoint and they evict each other's rooms forever.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);

export async function start(options: CreateServerOptions): Promise<Server> {
    const { _internal: driver } = options.driver;
    const runners = new Map(Object.entries(options.rooms));

    const host = options.host ?? '0.0.0.0';

    // fail fast: a networked driver publishes this server's endpoint to peers and
    // sdks. if the operator left serverEndpoint unset and the bind host is a
    // wildcard, the derived endpoint (http://0.0.0.0:port) is unroutable and every
    // server registers the same one — they mutually evict each other's rooms. a
    // local (in-process) driver shares state directly, so the endpoint is moot.
    if (!driver.local && !options.serverEndpoint && WILDCARD_HOSTS.has(host)) {
        throw new Error(
            'gatho: serverEndpoint is required with a networked driver when binding a wildcard host ' +
                `(${host || 'unset'}). the endpoint is published to other servers and sdks, so it must be a ` +
                'url they can reach — set serverEndpoint to e.g. "http://10.0.0.5:3000".',
        );
    }

    const s: ServerState = {
        options,
        driver,
        runners,
        port: options.port ?? 3000,
        host,
        serverId: randomUUID(),
        knownRoomTypes: new Set(Object.keys(options.rooms)),

        processes: new Map(),
        lastHeartbeats: new Map(),
        killedRoomIds: new Set(),
        spawning: new Set(),
        alive: true,

        openSockets: new Set(),

        heartbeatPunctuator: null,
        serverTags: options.tags ?? {},
        previouslyRegistered: false,

        unsubscribeRoomAssignments: null,

        isLeader: false,
        leaderPunctuator: null,

        httpServer: null,
        currentAddress: null,
        lastDriverHeartbeatAt: Date.now(),
    };

    await startInternal(s);

    return {
        serverId: s.serverId,
        stop: () => stop(s),
        address: () => s.currentAddress,
        getRoomDetails: (roomId) => getRoomDetails(s, roomId),
        getAllRoomDetails: () => getAllRoomDetails(s),
    };
}

/* test-only surface */

// a stripped-down local room used to drive heartbeatTick in isolation. the reap-
// recovery test needs a room with a ready status, an endpoint, and a spy on kill()
// without spinning up a real runner/subprocess.
export type TestRoom = {
    roomId: string;
    roomType: string;
    roomSecret: string;
    data: RoomData;
    endpoint: string | null;
    status: 'starting' | 'ready' | 'stopped';
};

// run a single heartbeatTick against a driver with the given local rooms already
// running. used by unit tests to assert the reap-recovery ordering (re-assert
// before destroy) deterministically, without the interval-driven loop. returns
// which rooms had kill() invoked so tests can assert nothing was destroyed.
export async function __heartbeatTickForTest(args: {
    driver: Driver['_internal'];
    serverId: string;
    endpoint: string;
    rooms: TestRoom[];
    previouslyRegistered: boolean;
}): Promise<{ killed: string[] }> {
    const killed: string[] = [];
    const processes = new Map<string, RoomProcess>();
    for (const r of args.rooms) {
        processes.set(r.roomId, {
            roomId: r.roomId,
            roomType: r.roomType,
            roomSecret: r.roomSecret,
            data: r.data,
            endpoint: r.endpoint,
            status: () => r.status,
            kill: () => killed.push(r.roomId),
            exited: Promise.resolve(),
            markExited: () => {},
        });
    }

    const s: ServerState = {
        options: {
            rooms: {},
            roomEndpoint: ({ port }) => `ws://localhost:${port}`,
            driver: { _internal: args.driver },
        },
        driver: args.driver,
        runners: new Map(),
        port: 0,
        host: '127.0.0.1',
        serverId: args.serverId,
        knownRoomTypes: new Set(),
        processes,
        lastHeartbeats: new Map(),
        killedRoomIds: new Set(),
        spawning: new Set(),
        alive: true,
        openSockets: new Set(),
        unsubscribeRoomAssignments: null,
        isLeader: false,
        leaderPunctuator: null,
        httpServer: null,
        currentAddress: null,
        heartbeatPunctuator: null,
        serverTags: {},
        lastDriverHeartbeatAt: Date.now(),
        previouslyRegistered: args.previouslyRegistered,
    };

    await heartbeatTick(s, args.endpoint, () => true);

    return { killed };
}
