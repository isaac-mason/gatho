import { randomUUID, randomBytes } from 'crypto';
import * as http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer as createServer$1 } from 'node:net';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

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

// shared uds framing protocol used by both room and server
//
// frame format: tag(1 byte) + length(4 bytes, uint32 BE) + payload(length bytes)
//   tag 0x00 = json text frame (utf-8 JSON, parsed with JSON.parse)
//   tag 0x01 = binary data frame (raw bytes, delivered as Uint8Array)
//
// messages with binary payloads (Uint8Array in data field) are sent as two frames:
// a json frame with { binary: true } replacing the data field, then a binary frame
// with the raw bytes. text messages are a single json frame.
// frame tags
const TAG_JSON = 0x00;
const TAG_BINARY = 0x01;
// header: 1 byte tag + 4 bytes uint32 BE length
const HEADER_SIZE = 5;
// --- frame writing ---
function buildFrame(tag, payload) {
    const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
    const frame = Buffer.alloc(HEADER_SIZE + payloadBuf.byteLength);
    frame[0] = tag;
    frame.writeUInt32BE(payloadBuf.byteLength, 1);
    frame.set(payloadBuf, HEADER_SIZE);
    return frame;
}
// send an ipc message. handles the json/binary split transparently.
// binary-payload messages are sent as two frames batched into one write call.
function sendMessage(socket, msg) {
    const rec = msg;
    if ('data' in rec && rec.data instanceof Uint8Array) {
        const { data, ...rest } = rec;
        const jsonFrame = buildFrame(TAG_JSON, JSON.stringify({ ...rest, binary: true }));
        const binFrame = buildFrame(TAG_BINARY, data);
        const combined = Buffer.alloc(jsonFrame.byteLength + binFrame.byteLength);
        combined.set(jsonFrame, 0);
        combined.set(binFrame, jsonFrame.byteLength);
        socket.write(combined);
        return;
    }
    socket.write(buildFrame(TAG_JSON, JSON.stringify(msg)));
}
// --- frame reading ---
// streaming frame reader — handles partial reads and buffering across data events
class FrameReader {
    buffer = Buffer.alloc(0);
    onFrame;
    constructor(onFrame) {
        this.onFrame = onFrame;
    }
    push(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.buffer = this.buffer.byteLength === 0 ? buf : Buffer.concat([this.buffer, buf]);
        while (this.buffer.byteLength >= HEADER_SIZE) {
            const tag = this.buffer[0];
            const payloadLength = this.buffer.readUInt32BE(1);
            const totalFrameSize = HEADER_SIZE + payloadLength;
            if (this.buffer.byteLength < totalFrameSize)
                break;
            const payload = Buffer.from(this.buffer.subarray(HEADER_SIZE, totalFrameSize));
            this.buffer = this.buffer.subarray(totalFrameSize);
            this.onFrame({ tag, payload });
        }
    }
}
// reassembles binary-flagged messages into typed ipc messages
function createMessageReceiver(handler) {
    let pendingJsonMsg = null;
    return (frame) => {
        if (frame.tag === TAG_JSON) {
            const parsed = JSON.parse(frame.payload.toString('utf-8'));
            if (parsed.binary === true) {
                pendingJsonMsg = parsed;
                return;
            }
            handler(parsed);
        }
        else if (frame.tag === TAG_BINARY) {
            if (pendingJsonMsg) {
                pendingJsonMsg.data = new Uint8Array(frame.payload);
                delete pendingJsonMsg.binary;
                handler(pendingJsonMsg);
                pendingJsonMsg = null;
            }
            // binary frame without pending json — protocol violation, drop
        }
    };
}

function listenOnSocket(socketPath, onMessage, options) {
    return new Promise((resolve, reject) => {
        const dir = dirname(socketPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        let settled = false;
        let timeoutHandle = null;
        const receiver = createMessageReceiver(onMessage);
        // clean up stale socket file if present
        try {
            unlinkSync(socketPath);
        }
        catch {
            // not there, fine
        }
        const server = createServer$1((socket) => {
            if (settled) {
                socket.destroy();
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            server.close();
            const reader = new FrameReader(receiver);
            const onClose = options?.onClose;
            socket.on('data', (chunk) => reader.push(chunk));
            socket.on('close', () => onClose?.());
            resolve({
                send(msg) {
                    sendMessage(socket, msg);
                },
                close() {
                    socket.destroy();
                    try {
                        unlinkSync(socketPath);
                    }
                    catch {
                        // already gone
                    }
                },
            });
        });
        server.on('error', (error) => {
            if (!settled) {
                settled = true;
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                reject(error);
            }
        });
        server.listen(socketPath);
        if (options?.timeoutMs !== undefined) {
            timeoutHandle = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    server.close();
                    try {
                        unlinkSync(socketPath);
                    }
                    catch (e) {
                        console.warn(`uds: failed to clean up socket file at ${socketPath} after timeout`, e);
                    }
                    reject(new Error(`uds: no connection within ${options.timeoutMs}ms on ${socketPath}`));
                }
            }, options.timeoutMs);
        }
    });
}
async function createUdsServer(socketPath, onMessage, options) {
    const conn = await listenOnSocket(socketPath, onMessage, options);
    return {
        close() {
            conn.close();
        },
    };
}

// createServer - main entry point for gatho server
// uses reconciliation loop for room spawning.
// rooms run their own websocket servers — clients connect directly.
// this process is control-plane only: health checks, reconciliation, leader election.
//
// the server owns the UDS socket for each room. it creates the socket,
// starts listening, spawns the room process (which connects back).
// room config is passed via env vars (GATHO_ROOM_ID, GATHO_ROOM_TYPE, etc.).
// all ipc flows over that socket — child-to-parent only.
/* constants */
const HEARTBEAT_TIMEOUT_MS = 10_000;
const LEADER_ELECTION_INTERVAL_MS = 15_000;
const LEADER_RENEWAL_INTERVAL_MS = 10_000;
const SERVER_HEARTBEAT_INTERVAL_MS = 10_000;
function cleanupRoom(s, roomId, reason) {
    const proc = s.processes.get(roomId);
    if (!proc)
        return;
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
            }
            else {
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
async function reconcileClients(s, roomId, roomClientIds) {
    const roomInfo = await s.driver.getRoomInfo(roomId);
    if (!roomInfo)
        return; // room already gone
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
function handleIpcMessage(s, roomId, msg) {
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
async function createRoom(s, roomId, roomType, data) {
    const runner = s.runners.get(roomType);
    if (!runner) {
        throw new Error(`no runner for room type "${roomType}"`);
    }
    const roomSecret = randomBytes(32).toString('base64url');
    const socketPath = join(s.socketDir, `${roomId}.sock`);
    let resolveExited;
    const exited = new Promise((r) => {
        resolveExited = r;
    });
    const roomProcess = {
        roomId,
        roomType,
        roomSecret,
        endpoint: null,
        kill: () => { },
        closeIpc: () => { },
        exited,
        markExited: () => resolveExited(),
    };
    function onMessage(msg) {
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
    const childExited = new Promise((_, reject) => {
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
function destroyWorker(s, roomId) {
    const roomProcess = s.processes.get(roomId);
    if (!roomProcess)
        return;
    s.killedRoomIds.add(roomId);
    roomProcess.kill();
}
function shutdownAllWorkers(s) {
    for (const roomId of Array.from(s.processes.keys())) {
        destroyWorker(s, roomId);
    }
}
/* heartbeat monitoring */
// sweep all process heartbeats — called at the top of each reconcile tick.
// kills stalled processes and reports failure to the driver.
function checkHeartbeats(s) {
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
async function startRoomSubscription(s) {
    s.unsubscribeRoomAssignments = await s.driver.subscribeRoomAssignments(s.serverId, (room) => {
        if (s.processes.has(room.roomId))
            return;
        if (s.spawning.has(room.roomId))
            return;
        if (!s.alive)
            return;
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
function stopRoomSubscription(s) {
    if (s.unsubscribeRoomAssignments) {
        s.unsubscribeRoomAssignments();
        s.unsubscribeRoomAssignments = null;
    }
}
/* reconciliation */
async function reconcileOnce(s) {
    if (s.reconciling)
        return;
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
    }
    finally {
        s.reconciling = false;
    }
}
function startReconciler(s, pollIntervalMs) {
    if (s.reconcileRunning)
        return Promise.resolve();
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
function stopReconciler(s) {
    s.reconcileRunning = false;
    if (s.reconcilePollInterval) {
        clearInterval(s.reconcilePollInterval);
        s.reconcilePollInterval = null;
    }
}
/* leader election & duties */
async function reapStaleServers(s) {
    const stale = await s.driver.listStaleServers();
    for (const server of stale) {
        log.info('reaping stale server', { staleServerId: server.serverId, endpoint: server.endpoint });
        await s.driver.unregisterServer(server.serverId);
    }
}
async function cleanOrphanedRoomEntries(s) {
    // snapshot servers first, then rooms. a room created after the servers
    // snapshot won't appear in server.rooms, so it can't be falsely flagged
    // as orphaned. the reverse ordering was racy: a room created between
    // listRooms() and listServers() would appear in server.rooms but not
    // in the rooms snapshot, getting incorrectly deleted.
    const servers = await s.driver.listServers();
    const staleServers = await s.driver.listStaleServers();
    const allServers = [...servers, ...staleServers];
    // collect all room ids referenced by servers
    const serverRoomIds = new Set();
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
async function runLeaderDuties(s) {
    await reapStaleServers(s);
    await cleanOrphanedRoomEntries(s);
}
async function attemptLeaderElection(s) {
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
function startLeaderLoop(s) {
    attemptLeaderElection(s).catch((err) => {
        log.error('leader election error', { err });
    });
    s.leaderLoopInterval = setInterval(() => {
        attemptLeaderElection(s).catch((err) => {
            log.error('leader election error', { err });
        });
    }, LEADER_ELECTION_INTERVAL_MS);
}
function stopLeaderLoop(s) {
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
function handleRequest(_req, res) {
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
async function start(s) {
    s.httpServer = http.createServer(handleRequest);
    s.httpServer.on('connection', (socket) => {
        s.openSockets.add(socket);
        socket.on('close', () => s.openSockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        s.httpServer.on('error', reject);
        s.httpServer.listen(s.port, s.host, () => {
            const addr = s.httpServer.address();
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
async function stop(s) {
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
        await Promise.race([Promise.all(exitPromises), new Promise((r) => setTimeout(r, drainTimeoutMs))]);
    }
    // 7. destroy all open sockets and close http server
    for (const socket of s.openSockets) {
        socket.destroy();
    }
    s.openSockets.clear();
    if (s.httpServer) {
        await Promise.race([
            new Promise((resolve) => s.httpServer.close(() => resolve())),
            new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
        s.httpServer = null;
    }
    // 8. cleanup
    s.currentAddress = null;
}
/* introspection */
function getRoomDetails(s, roomId) {
    const roomProcess = s.processes.get(roomId);
    if (!roomProcess)
        return null;
    return {
        roomId,
        roomType: roomProcess.roomType,
        workerRunning: true,
        endpoint: roomProcess.endpoint,
    };
}
function getAllRoomDetails(s) {
    const details = [];
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
function createServer(options) {
    const { _internal: driver } = options.driver;
    const runners = new Map(Object.entries(options.rooms));
    const socketDir = join(tmpdir(), 'gatho-ipc');
    const s = {
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

const SIGKILL_DELAY_MS = 5_000;
/**
 * RoomRunner factory for spawning a subprocess for each room. The subprocess should call `gatho/room`'s `start()` function (`import { start } from 'gatho/room'`)
 *
 * The process will be started with the following environment variables, which `start()` will pick up automatically:
 * - `GATHO_ROOM_ID`: the room's unique identifier
 * - `GATHO_SOCKET`: the uds socket path for ipc communication with the server
 * - `GATHO_ROOM_TYPE`: the room type string
 * - `GATHO_SERVER_ID`: the id of the server this room is running on
 * - `GATHO_ROOM_SECRET`: a per-room secret for signing JWTs
 *
 * @param command the full argv array for the subprocess, e.g. `['bun', 'run', 'game-room.ts']`
 * @param options additional options for environment variables and kill timeout
 * @returns a RoomRunner that spawns a subprocess for each room with the specified command and environment variables
 */
function subprocess(command, options) {
    return {
        spawn(ctx) {
            const killTimeout = options?.killTimeoutMs ?? SIGKILL_DELAY_MS;
            const child = spawn(command[0], command.slice(1), {
                env: {
                    ...process.env,
                    ...options?.env,
                    GATHO_ROOM_ID: ctx.roomId,
                    GATHO_SOCKET: ctx.socket,
                    GATHO_ROOM_TYPE: ctx.roomType,
                    GATHO_SERVER_ID: ctx.serverId,
                    GATHO_ROOM_SECRET: ctx.roomSecret,
                },
                stdio: ['ignore', 'inherit', 'inherit'],
            });
            let killed = false;
            let escalationTimer = null;
            child.on('exit', () => {
                killed = true;
                if (escalationTimer) {
                    clearTimeout(escalationTimer);
                    escalationTimer = null;
                }
            });
            return {
                kill() {
                    if (killed)
                        return;
                    // SIGTERM — let the process handle it gracefully
                    child.kill('SIGTERM');
                    // escalate to SIGKILL if it doesn't exit in time
                    escalationTimer = setTimeout(() => {
                        if (!killed) {
                            child.kill('SIGKILL');
                        }
                    }, killTimeout);
                    escalationTimer.unref();
                },
                onExit(handler) {
                    child.on('exit', (code) => handler(code));
                },
            };
        },
    };
}

export { createServer, subprocess };
//# sourceMappingURL=server.js.map
