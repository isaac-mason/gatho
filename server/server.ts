// createServer - main entry point for gatho server
// uses reconciliation loop for room spawning.
// rooms run their own websocket servers — clients connect directly.
// this process is control-plane only: health checks, reconciliation, leader election.
//
// the server owns the UDS socket for each room. it creates the socket,
// starts listening, spawns the room process (which connects back).
// room config is passed via env vars (GATHO_ROOM_ID, GATHO_ROOM_TYPE, etc.).
// all ipc flows over that socket — child-to-parent only.

import { randomBytes, randomUUID } from 'crypto';
import * as http from 'http';
import type { Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { log } from '../common/logger';
import type { Driver, RoomData } from '../driver/types';
import type { RoomMessage } from '../common/uds';
import type { RoomRunner } from './runner/types';
import { createUdsServer } from './runner/uds';

/* exported types */

export type RoomEndpointFn = (info: { roomId: string; port: number }) => string;

export type CreateServerOptions = {
    /** map of supported room types to their corresponding RoomRunner */
    rooms: Record<string, RoomRunner>;
    /** driver instance for multi-server communication */
    driver: Driver;
    /** returns the full ws:// or wss:// URL clients will connect to for a room */
    roomEndpoint: RoomEndpointFn;
    /** port to listen on for admin HTTP endpoint (health, ping) and driver communication */
    port?: number;
    /** host to listen on for admin HTTP endpoint and driver communication */
    host?: string;
    /** interval for reconciliation loop in milliseconds */
    reconcileIntervalMs?: number;
    /** tags for this server instance */
    tags: Record<string, string>;
    /** timeout for draining rooms in milliseconds */
    drainTimeoutMs?: number;
    /** full URL for this server's admin HTTP endpoint, e.g. "http://localhost:3000" or "https://us-east.mysite.com".
     *  if not set, defaults to "http://{host}:{port}" using the bound address. */
    serverEndpoint?: string;
};

export type RoomDetails = {
    roomId: string;
    roomType: string;
    workerRunning: boolean;
    endpoint: string | null;
};

export type Server = {
    start(): Promise<void>;
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
    endpoint: string | null;
    kill(): void;
    closeIpc(): void;
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
    socketDir: string;

    // processes
    processes: Map<string, RoomProcess>;
    lastHeartbeats: Map<string, number>;
    killedRoomIds: Set<string>;
    spawning: Set<string>;
    alive: boolean;

    // network
    openSockets: Set<Socket>;

    // reconciliation
    reconciling: boolean;
    reconcileRunning: boolean;
    reconcilePollInterval: ReturnType<typeof setInterval> | null;

    // room assignment subscription
    unsubscribeRoomAssignments: (() => void) | null;

    // leader election
    isLeader: boolean;
    leaderLoopInterval: ReturnType<typeof setInterval> | null;
    leaderRenewalInterval: ReturnType<typeof setInterval> | null;

    // http
    httpServer: http.Server | null;
    currentAddress: { host: string; port: number } | null;
    serverHeartbeatInterval: ReturnType<typeof setInterval> | null;
};

/* constants */

const HEARTBEAT_TIMEOUT_MS = 10_000;
const LEADER_ELECTION_INTERVAL_MS = 15_000;
const LEADER_RENEWAL_INTERVAL_MS = 10_000;
const SERVER_HEARTBEAT_INTERVAL_MS = 10_000;

/* centralized room cleanup */

// single cleanup path for a room process. idempotent — no-ops if already cleaned up.
// all teardown paths (ipc close, process exit, self-stop, heartbeat timeout)
// go through here instead of doing inline cleanup.
type CleanupReason = 'ipc-closed' | 'process-exited' | 'self-stopped' | 'heartbeat-timeout';

function cleanupRoom(s: ServerState, roomId: string, reason: CleanupReason): void {
    const proc = s.processes.get(roomId);
    if (!proc) return;

    s.processes.delete(roomId);
    s.lastHeartbeats.delete(roomId);
    proc.closeIpc();
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
        case 'ipc-closed':
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
// the room's clientIds are authoritative — if a fast-path connect/disconnect
// message was lost (e.g. transient driver error), this corrects the drift.
async function reconcileClients(s: ServerState, roomId: string, roomClientIds: string[]): Promise<void> {
    const roomInfo = await s.driver.getRoomInfo(roomId);
    if (!roomInfo) return; // room already gone

    const roomSet = new Set(roomClientIds);

    // clients the room says are connected but the driver doesn't have as 'connected'
    for (const clientId of roomClientIds) {
        const driverClient = roomInfo.clients.find((c) => c.clientId === clientId);
        if (!driverClient || driverClient.status !== 'connected') {
            log.info('reconcile: connecting client missing from driver', { roomId, clientId });
            await s.driver.connectClient(clientId).catch((err) => {
                log.error('reconcile: failed to connect client', { roomId, clientId, err });
            });
        }
    }

    // clients the driver thinks are connected but the room doesn't have
    for (const driverClient of roomInfo.clients) {
        if (driverClient.status === 'connected' && !roomSet.has(driverClient.clientId)) {
            log.info('reconcile: disconnecting stale client from driver', { roomId, clientId: driverClient.clientId });
            await s.driver.disconnectClient(driverClient.clientId).catch((err) => {
                log.error('reconcile: failed to disconnect client', { roomId, clientId: driverClient.clientId, err });
            });
        }
    }
}

// handle all ipc messages from a room subprocess.
// single dispatch point — every ChildToParent message type is handled here.
function handleIpcMessage(s: ServerState, roomId: string, msg: RoomMessage): void {
    switch (msg.type) {
        case 'heartbeat': {
            s.lastHeartbeats.set(roomId, Date.now());

            const proc = s.processes.get(roomId);
            log.debug('room heartbeat', {
                roomId,
                roomType: proc?.roomType,
                memoryRss: msg.metrics.memoryRss,
                memoryHeapUsed: msg.metrics.memoryHeapUsed,
                cpuUser: msg.metrics.cpuUser,
                cpuSystem: msg.metrics.cpuSystem,
                clientCount: msg.clientIds.length,
            });

            // reconcile client state in the background — don't block the heartbeat path
            reconcileClients(s, roomId, msg.clientIds).catch((err) => {
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
            s.driver.connectClient(msg.clientId).catch((err) => {
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

// spawn a new room subprocess via the injected runner.
// 1. creates a UDS socket at socketDir/roomId.sock and starts listening
// 2. calls runner.spawn() to start the process (which connects back)
// 3. ipc messages from the child are handled by handleIpcMessage()
// 4. when the room sends 'ready' with wsPort, computes endpoint and registers with driver
async function createRoom(s: ServerState, roomId: string, roomType: string, data: RoomData): Promise<RoomProcess> {
    const runner = s.runners.get(roomType);
    if (!runner) {
        throw new Error(`no runner for room type "${roomType}"`);
    }

    const roomSecret = randomBytes(32).toString('base64url');
    const socketPath = join(s.socketDir, `${roomId}.sock`);

    let resolveExited: () => void;
    const exited = new Promise<void>((r) => {
        resolveExited = r;
    });

    const roomProcess: RoomProcess = {
        roomId,
        roomType,
        roomSecret,
        endpoint: null,
        kill: () => {},
        closeIpc: () => {},
        exited,
        markExited: () => resolveExited(),
    };

    function onMessage(msg: RoomMessage): void {
        handleIpcMessage(s, roomId, msg);
    }

    // start listening on UDS socket — don't await yet, we need to spawn first.
    // createUdsServer resolves when the child connects, so we must spawn the
    // child process before awaiting, otherwise it's a deadlock.
    const udsPromise = createUdsServer(socketPath, onMessage, {
        timeoutMs: 30_000,
        onClose() {
            cleanupRoom(s, roomId, 'ipc-closed');
        },
    });

    // spawn the room process — it will connect back to our socket
    const spawnResult = runner.spawn({
        roomId,
        roomType,
        serverId: s.serverId,
        roomSecret,
        data,
        socket: socketPath,
    });

    // race UDS connection against child exit — if the child crashes before
    // connecting (bad path, syntax error, etc.), we reject immediately instead
    // of blocking for the full 30s UDS timeout.
    const childExited = new Promise<never>((_, reject) => {
        spawnResult.onExit((code) => {
            reject(new Error(`room process exited during startup (code ${code})`));
        });
    });

    const uds = await Promise.race([udsPromise, childExited]);

    // wire up the room process handle
    roomProcess.kill = () => spawnResult.kill();
    roomProcess.closeIpc = () => uds.close();

    // now that the process is registered, wire up exit handler for post-startup
    // crashes. if the child exited during startup, the race above already rejected
    // and we never reach here.
    spawnResult.onExit((_code) => {
        cleanupRoom(s, roomId, 'process-exited');
    });

    s.processes.set(roomId, roomProcess);
    s.lastHeartbeats.set(roomId, Date.now());

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
    for (const [roomId, lastBeat] of s.lastHeartbeats) {
        if (now - lastBeat > HEARTBEAT_TIMEOUT_MS) {
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

/* reconciliation */

async function reconcileOnce(s: ServerState): Promise<void> {
    if (s.reconciling) return;
    s.reconciling = true;

    try {
        checkHeartbeats(s);

        const desiredIds = new Set((await s.driver.getDesiredState(s.serverId)).map((r) => r.roomId));

        // kill rooms that shouldn't be running
        for (const roomId of s.processes.keys()) {
            if (!desiredIds.has(roomId)) {
                destroyWorker(s, roomId);
            }
        }
    } finally {
        s.reconciling = false;
    }
}

function startReconciler(s: ServerState, pollIntervalMs: number): Promise<void> {
    if (s.reconcileRunning) return Promise.resolve();
    s.reconcileRunning = true;

    s.reconcilePollInterval = setInterval(() => {
        if (s.reconcileRunning) {
            reconcileOnce(s).catch((err) => {
                log.error('reconcile error', { err });
            });
        }
    }, pollIntervalMs);

    return reconcileOnce(s);
}

function stopReconciler(s: ServerState): void {
    s.reconcileRunning = false;
    if (s.reconcilePollInterval) {
        clearInterval(s.reconcilePollInterval);
        s.reconcilePollInterval = null;
    }
}

/* leader election & duties */

async function reapStaleServers(s: ServerState): Promise<void> {
    const stale = await s.driver.listStaleServers();
    for (const server of stale) {
        log.info('reaping stale server', { staleServerId: server.serverId, endpoint: server.endpoint });
        await s.driver.unregisterServer(server.serverId);
    }
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

    for (const roomId of serverRoomIds) {
        if (!liveRoomIds.has(roomId)) {
            await s.driver.unregisterRoom(roomId);
        }
    }
}

async function runLeaderDuties(s: ServerState): Promise<void> {
    await reapStaleServers(s);
    await cleanOrphanedRoomEntries(s);
}

async function attemptLeaderElection(s: ServerState): Promise<void> {
    if (s.isLeader) {
        await runLeaderDuties(s);
        return;
    }

    const acquired = await s.driver.tryAcquireLeader(s.serverId);
    if (acquired) {
        s.isLeader = true;
        log.info('acquired leadership', { serverId: s.serverId });

        s.leaderRenewalInterval = setInterval(async () => {
            const renewed = await s.driver.renewLeader(s.serverId);
            if (!renewed) {
                log.warn('lost leadership (renewal failed)', { serverId: s.serverId });
                s.isLeader = false;
                if (s.leaderRenewalInterval) {
                    clearInterval(s.leaderRenewalInterval);
                    s.leaderRenewalInterval = null;
                }
            }
        }, LEADER_RENEWAL_INTERVAL_MS);

        await runLeaderDuties(s);
    }
}

function startLeaderLoop(s: ServerState): void {
    attemptLeaderElection(s).catch((err) => {
        log.error('leader election error', { err });
    });

    s.leaderLoopInterval = setInterval(() => {
        attemptLeaderElection(s).catch((err) => {
            log.error('leader election error', { err });
        });
    }, LEADER_ELECTION_INTERVAL_MS);
}

function stopLeaderLoop(s: ServerState): void {
    if (s.leaderLoopInterval) {
        clearInterval(s.leaderLoopInterval);
        s.leaderLoopInterval = null;
    }
    if (s.leaderRenewalInterval) {
        clearInterval(s.leaderRenewalInterval);
        s.leaderRenewalInterval = null;
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

async function start(s: ServerState): Promise<void> {
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

    const adminHost = s.currentAddress?.host ?? s.host;
    const adminPort = s.currentAddress?.port ?? s.port;
    const adminEndpoint = s.options.serverEndpoint ?? `http://${adminHost}:${adminPort}`;

    // subscribe to room assignments before registering — if we register first,
    // an sdk could assign a room before we're listening and the message is lost
    await startRoomSubscription(s);

    await s.driver.registerServer({
        serverId: s.serverId,
        endpoint: adminEndpoint,
        tags: s.options.tags,
        roomTypes: Array.from(s.knownRoomTypes),
    });

    s.serverHeartbeatInterval = setInterval(() => {
        s.driver.heartbeat(s.serverId).catch((err) => {
            log.error('server heartbeat error', { err });
        });
    }, SERVER_HEARTBEAT_INTERVAL_MS);

    startLeaderLoop(s);

    await startReconciler(s, s.options.reconcileIntervalMs ?? 5000);
}

async function stop(s: ServerState): Promise<void> {
    s.alive = false;

    // 1. stop room assignment subscription — no new spawns
    stopRoomSubscription(s);

    // 2. stop reconciliation
    stopReconciler(s);

    // 3. stop leader loop and release leader lock
    stopLeaderLoop(s);
    if (s.isLeader) {
        await s.driver.releaseLeader(s.serverId);
        s.isLeader = false;
    }

    // 4. stop server heartbeat
    if (s.serverHeartbeatInterval) {
        clearInterval(s.serverHeartbeatInterval);
        s.serverHeartbeatInterval = null;
    }

    // 5. unregister server from driver
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
        });
    }
    return details;
}

/* createServer */

export function createServer(options: CreateServerOptions): Server {
    const { _internal: driver } = options.driver;
    const runners = new Map(Object.entries(options.rooms));
    const socketDir = join(tmpdir(), 'gatho-ipc');

    const s: ServerState = {
        options,
        driver,
        runners,
        port: options.port ?? 3000,
        host: options.host ?? '0.0.0.0',
        serverId: randomUUID(),
        knownRoomTypes: new Set(Object.keys(options.rooms)),
        socketDir,

        processes: new Map(),
        lastHeartbeats: new Map(),
        killedRoomIds: new Set(),
        spawning: new Set(),
        alive: true,

        openSockets: new Set(),

        reconciling: false,
        reconcileRunning: false,
        reconcilePollInterval: null,

        unsubscribeRoomAssignments: null,

        isLeader: false,
        leaderLoopInterval: null,
        leaderRenewalInterval: null,

        httpServer: null,
        currentAddress: null,
        serverHeartbeatInterval: null,
    };

    return {
        serverId: s.serverId,
        start: () => start(s),
        stop: () => stop(s),
        address: () => s.currentAddress,
        getRoomDetails: (roomId) => getRoomDetails(s, roomId),
        getAllRoomDetails: () => getAllRoomDetails(s),
    };
}
