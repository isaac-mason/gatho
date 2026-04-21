import { randomUUID, randomBytes } from 'node:crypto';
import { sendMessage, createLogger, packProtocol, unpackFrame, jwtVerify, frameUserMessage } from 'gatho/common';
import { createConnection } from 'node:net';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

// room-side ipc: connect to the parent server's uds socket.
// rooms only ever send to the server — they never receive.
// so no frame reading is needed; we just wire up the send side.
function connectToSocket(socketPath, options) {
    const maxRetries = 50;
    const retryDelay = 20;
    return new Promise((resolve, reject) => {
        let attempt = 0;
        const tryConnect = () => {
            const socket = createConnection({ path: socketPath });
            let connected = false;
            socket.on('connect', () => {
                connected = true;
                resolve({
                    send(msg) {
                        sendMessage(socket, msg);
                    },
                    close() {
                        socket.destroy();
                    },
                });
            });
            socket.on('error', (error) => {
                if (connected)
                    return;
                socket.destroy();
                attempt++;
                if (attempt >= maxRetries) {
                    reject(new Error(`uds: failed to connect to ${socketPath} after ${maxRetries} attempts: ${error.message}`));
                    return;
                }
                setTimeout(tryConnect, retryDelay);
            });
        };
        tryConnect();
    });
}

// ws transport — uses the `ws` npm package.
// works on node and bun. zero native addons.
//
// pub/sub is implemented manually since ws doesn't have built-in
// topic-based broadcast like uWebSockets.js.
function wsTransport(config) {
    return {
        listen(handlers, listenConfig) {
            return new Promise((resolve, reject) => {
                const httpServer = createServer((_req, res) => {
                    // reject plain http requests — this server is ws-only
                    res.writeHead(426, { 'Content-Type': 'text/plain' });
                    res.end('upgrade required');
                });
                const wss = new WebSocketServer({
                    noServer: true,
                    maxPayload: config?.maxPayload ?? 1024 * 1024,
                    perMessageDeflate: config?.perMessageDeflate ?? false,
                });
                // connection state keyed by ws instance
                const connections = new Map();
                // reverse lookup: clientId -> ws
                const clientSockets = new Map();
                // topic subscriptions: topic -> set of ws instances
                const topics = new Map();
                // handle http upgrade — this is where auth happens
                httpServer.on('upgrade', (req, socket, head) => {
                    const query = req.url?.split('?')[1] ?? '';
                    const result = handlers.upgrade(query);
                    if (!result) {
                        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                        socket.destroy();
                        return;
                    }
                    const { clientId, reconnecting } = result;
                    const joinData = result.joinData ?? {};
                    wss.handleUpgrade(req, socket, head, (ws) => {
                        // if reconnecting, clean up the old socket for this clientId
                        // (it may already be gone if the old connection closed cleanly)
                        const oldWs = clientSockets.get(clientId);
                        if (oldWs) {
                            const oldState = connections.get(oldWs);
                            if (oldState) {
                                for (const topic of oldState.topics) {
                                    const subs = topics.get(topic);
                                    if (subs) {
                                        subs.delete(oldWs);
                                        if (subs.size === 0) {
                                            topics.delete(topic);
                                        }
                                    }
                                }
                            }
                            connections.delete(oldWs);
                            // don't call oldWs.close() — it's already dead or will be
                        }
                        const state = {
                            clientId,
                            topics: new Set(),
                        };
                        connections.set(ws, state);
                        clientSockets.set(clientId, ws);
                        // build the WsSocket abstraction for start.ts
                        const wsSocket = {
                            send(data, isBinary) {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(data, { binary: isBinary });
                                }
                            },
                            close(code, reason) {
                                ws.close(code, reason);
                            },
                            subscribe(topic) {
                                state.topics.add(topic);
                                let subs = topics.get(topic);
                                if (!subs) {
                                    subs = new Set();
                                    topics.set(topic, subs);
                                }
                                subs.add(ws);
                            },
                        };
                        if (reconnecting) {
                            handlers.reconnect(clientId, wsSocket);
                        }
                        else {
                            handlers.open(clientId, wsSocket, joinData);
                        }
                        ws.on('message', (data, isBinary) => {
                            // normalize to arraybuffer — consistent with transport interface.
                            // we copy into a fresh ArrayBuffer to avoid SharedArrayBuffer issues
                            // with Buffer.buffer on some runtimes.
                            let ab;
                            if (data instanceof ArrayBuffer) {
                                ab = data;
                            }
                            else if (Buffer.isBuffer(data)) {
                                const copy = new Uint8Array(data.byteLength);
                                copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                                ab = copy.buffer;
                            }
                            else {
                                // Buffer[] (fragments) — concat then copy
                                const buf = Buffer.concat(data);
                                const copy = new Uint8Array(buf.byteLength);
                                copy.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
                                ab = copy.buffer;
                            }
                            handlers.message(clientId, ab, isBinary);
                        });
                        ws.on('close', (code) => {
                            // clean up topic subscriptions
                            for (const topic of state.topics) {
                                const subs = topics.get(topic);
                                if (subs) {
                                    subs.delete(ws);
                                    if (subs.size === 0) {
                                        topics.delete(topic);
                                    }
                                }
                            }
                            connections.delete(ws);
                            clientSockets.delete(clientId);
                            handlers.close(clientId, code);
                        });
                    });
                });
                // listen on configured port, or 0 for os-assigned
                httpServer.listen(listenConfig?.port ?? 0, () => {
                    const addr = httpServer.address();
                    if (!addr || typeof addr === 'string') {
                        reject(new Error('failed to get server address'));
                        return;
                    }
                    const server = {
                        port: addr.port,
                        publish(topic, data, isBinary) {
                            const subs = topics.get(topic);
                            if (!subs)
                                return;
                            for (const ws of subs) {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(data, { binary: isBinary });
                                }
                            }
                        },
                        close() {
                            // close all ws connections
                            for (const ws of connections.keys()) {
                                ws.close(1001, 'server shutting down');
                            }
                            wss.close();
                            httpServer.close();
                        },
                    };
                    resolve(server);
                });
                httpServer.on('error', reject);
            });
        },
    };
}

const HEARTBEAT_INTERVAL_MS = 3000;
function safeCall(log, label, fn) {
    Promise.resolve()
        .then(fn)
        .catch((err) => {
        log.error(`${label} threw unexpectedly`, { err });
    });
}
// topic used for pub/sub broadcast
const BROADCAST_TOPIC = 'room';
function createClient(tracked) {
    return { id: tracked.id, data: tracked.data };
}
function createClientCollection(clients) {
    return {
        get(id) {
            const c = clients.get(id);
            if (!c)
                return undefined;
            return createClient(c);
        },
        has(id) {
            return clients.has(id);
        },
        count() {
            return clients.size;
        },
        forEach(callback) {
            for (const [id, c] of clients) {
                callback(createClient(c), id);
            }
        },
        ids() {
            return Array.from(clients.keys());
        },
        all() {
            return Array.from(clients.values()).map((c) => createClient(c));
        },
    };
}
// default per-client reliable message buffer cap: 1mb
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576;
// permanently remove a client — cancel timers, invalidate session token,
// fire onLeave, notify driver. used on reconnect window expiry, buffer overflow,
// consented close, and disconnect without allowReconnection.
function evictClient(state, tracked, room, onLeave) {
    if (tracked.disconnectTimer) {
        clearTimeout(tracked.disconnectTimer);
        tracked.disconnectTimer = null;
    }
    // invalidate session token
    state.sessionTokens.delete(tracked.sessionToken);
    // clear buffer
    tracked.reliableBuffer.length = 0;
    tracked.reliableBufferBytes = 0;
    // close socket if still open
    tracked.socket?.close(4000, 'evicted');
    // remove from clients map
    state.clients.delete(tracked.id);
    // fire onLeave
    if (onLeave) {
        safeCall(state.log, 'onLeave', () => onLeave(room, createClient(tracked)));
    }
    // notify driver
    state.ipc?.send({ type: 'client-disconnected', clientId: tracked.id });
}
function createRoom(state, maxBufferBytes, callbacks) {
    let room;
    // buffer a reliable message for a disconnected client.
    // if byte cap exceeded, evict the client.
    function bufferForClient(tracked, payload) {
        const byteSize = payload.byteLength;
        tracked.reliableBuffer.push({ payload, byteSize });
        tracked.reliableBufferBytes += byteSize;
        if (tracked.reliableBufferBytes > maxBufferBytes) {
            evictClient(state, tracked, room, callbacks.onLeave);
        }
    }
    room = {
        get roomId() {
            return state.roomId;
        },
        get roomType() {
            return state.roomType;
        },
        get serverId() {
            return state.serverId;
        },
        send(client, message, options) {
            if (!state.alive)
                return;
            const tracked = state.clients.get(client.id);
            if (!tracked)
                return;
            const framed = frameUserMessage(message);
            const reliable = options?.reliable !== false;
            if (tracked.socket) {
                tracked.socket.send(framed, true);
            }
            else if (reliable) {
                bufferForClient(tracked, framed);
            }
        },
        broadcast(message, options) {
            if (!state.alive)
                return;
            if (!state.server)
                return;
            const framed = frameUserMessage(message);
            const reliable = options?.reliable !== false;
            state.server.publish(BROADCAST_TOPIC, framed, true);
            if (reliable) {
                for (const tracked of state.clients.values()) {
                    if (!tracked.socket) {
                        bufferForClient(tracked, framed);
                    }
                }
            }
        },
        get clients() {
            return createClientCollection(state.clients);
        },
        allowReconnection(client, windowMs) {
            const tracked = state.clients.get(client.id);
            if (!tracked)
                return;
            // only meaningful when the client is disconnected
            if (tracked.socket)
                return;
            // set up the disconnect timer — when it fires, the client is evicted
            tracked.disconnectTimer = setTimeout(() => {
                tracked.disconnectTimer = null;
                evictClient(state, tracked, room, callbacks.onLeave);
            }, windowMs);
        },
        disconnect(client) {
            const tracked = state.clients.get(client.id);
            if (!tracked)
                return;
            // server-initiated consented close — skip onDrop, straight to eviction
            evictClient(state, tracked, room, callbacks.onLeave);
        },
        stop() {
            return stopRoom(state, true, room, callbacks.onShutdown, callbacks.onLeave);
        },
    };
    return room;
}
// --- heartbeat ---
function startHeartbeat(state) {
    if (!state.ipc)
        return;
    const ipc = state.ipc;
    state.heartbeatInterval = setInterval(() => {
        if (!state.alive)
            return;
        // collect ids of clients with an active socket — these are the
        // ground truth for who is connected. clients in the reconnection
        // window (socket === null) have already been reported as disconnected.
        const clientIds = [];
        for (const [id, tracked] of state.clients) {
            if (tracked.socket !== null) {
                clientIds.push(id);
            }
        }
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        ipc.send({
            type: 'heartbeat',
            timestamp: Date.now(),
            metrics: {
                memoryRss: mem.rss,
                memoryHeapUsed: mem.heapUsed,
                memoryHeapTotal: mem.heapTotal,
                cpuUser: cpu.user,
                cpuSystem: cpu.system,
            },
            clientIds,
        });
    }, HEARTBEAT_INTERVAL_MS);
}
// --- ws server ---
function startRoom(state, transport, options) {
    // the room handle is created once and shared — same object passed to callbacks
    // and returned from start()
    const room = createRoom(state, options.maxBufferBytes, {
        onLeave: options.onLeave,
        onShutdown: options.onShutdown,
    });
    const handlers = {
        upgrade(query) {
            const params = new URLSearchParams(query);
            // check for session token — reconnection attempt
            const sessionParam = params.get('session');
            if (sessionParam) {
                const clientId = state.sessionTokens.get(sessionParam);
                if (clientId) {
                    const tracked = state.clients.get(clientId);
                    // valid reconnection: client exists and is disconnected
                    if (tracked && tracked.socket === null) {
                        return { clientId, reconnecting: true };
                    }
                }
                // invalid/expired session — still upgrade the connection so
                // we can send __auth_error as a websocket message. if we
                // returned null here, the transport would send a raw 401 HTTP
                // response and the client couldn't distinguish "server down"
                // from "session expired", causing infinite retries.
                // the reconnect handler will see the client doesn't exist
                // and send __auth_error.
                return { clientId: sessionParam, reconnecting: true };
            }
            if (state.roomSecret) {
                // authenticated mode — verify jwt
                const token = params.get('token');
                if (!token)
                    return null;
                const payload = jwtVerify(token, state.roomSecret);
                if (!payload)
                    return null;
                const clientId = payload.clientId;
                const roomId = payload.roomId;
                const joinData = payload.data ?? {};
                // verify the token is for this room
                if (roomId !== state.roomId)
                    return null;
                return { clientId, joinData };
            }
            // dev mode — no jwt verification, generate identity
            return { clientId: randomUUID(), joinData: {} };
        },
        open(clientId, socket, joinData) {
            socket.subscribe(BROADCAST_TOPIC);
            (async () => {
                let result;
                try {
                    result = await Promise.resolve(options.onAuth ? options.onAuth(room, joinData) : { ok: true, data: {} });
                }
                catch (err) {
                    // onAuth threw — bug in user code
                    state.log.error('onAuth threw unexpectedly', { clientId, err });
                    socket.send(packProtocol({ type: 'auth_error', error: 'internal error' }), true);
                    socket.close(1011, 'internal error');
                    return;
                }
                if (!result.ok) {
                    socket.send(packProtocol({ type: 'auth_error', error: String(result.error) }), true);
                    socket.close(4000, 'auth rejected');
                    return;
                }
                // generate session token
                const sessionToken = randomBytes(16).toString('hex');
                state.sessionTokens.set(sessionToken, clientId);
                // track client
                const tracked = {
                    id: clientId,
                    data: result.data,
                    socket,
                    sessionToken,
                    reliableBuffer: [],
                    reliableBufferBytes: 0,
                    disconnectTimer: null,
                };
                state.clients.set(clientId, tracked);
                // send session token to client
                socket.send(packProtocol({ type: 'session', token: sessionToken }), true);
                // notify server for driver bookkeeping (managed mode only)
                state.ipc?.send({ type: 'client-connected', clientId });
                // run onJoin
                if (options.onJoin) {
                    await Promise.resolve(options.onJoin(room, createClient(tracked)));
                }
            })().catch((err) => {
                state.log.error('onJoin threw unexpectedly', { clientId, err });
            });
        },
        message(clientId, data, _isBinary) {
            const tracked = state.clients.get(clientId);
            if (!tracked?.socket)
                return;
            const frame = unpackFrame(data);
            if (frame.frame === 'protocol') {
                if (frame.message.type === 'leave') {
                    tracked.socket.close(4000, 'consented leave');
                }
                return;
            }
            if (options.onMessage) {
                if (frame.frame === 'user_text') {
                    safeCall(state.log, 'onMessage', () => options.onMessage(room, createClient(tracked), frame.text));
                }
                else {
                    safeCall(state.log, 'onMessage', () => options.onMessage(room, createClient(tracked), frame.data));
                }
            }
        },
        reconnect(clientId, socket) {
            const tracked = state.clients.get(clientId);
            if (!tracked || tracked.socket !== null) {
                // not a valid reconnection target — close
                socket.send(packProtocol({ type: 'auth_error', error: 'invalid session' }), true);
                socket.close(4000, 'invalid session');
                return;
            }
            // cancel the disconnect timer
            if (tracked.disconnectTimer) {
                clearTimeout(tracked.disconnectTimer);
                tracked.disconnectTimer = null;
            }
            // swap socket
            tracked.socket = socket;
            // subscribe new socket to broadcast topic
            socket.subscribe(BROADCAST_TOPIC);
            // invalidate old session token, generate new one
            state.sessionTokens.delete(tracked.sessionToken);
            const newToken = randomBytes(16).toString('hex');
            tracked.sessionToken = newToken;
            state.sessionTokens.set(newToken, clientId);
            // flush reliable buffer to client (FIFO)
            for (const buffered of tracked.reliableBuffer) {
                socket.send(buffered.payload, true);
            }
            tracked.reliableBuffer.length = 0;
            tracked.reliableBufferBytes = 0;
            // send new session token — this is the "reconnection handshake complete" signal
            socket.send(packProtocol({ type: 'session', token: newToken }), true);
            // fire onReconnect
            if (options.onReconnect) {
                safeCall(state.log, 'onReconnect', () => options.onReconnect(room, createClient(tracked)));
            }
            // notify driver: client is connected again
            state.ipc?.send({ type: 'client-connected', clientId });
        },
        close(clientId, code) {
            const tracked = state.clients.get(clientId);
            if (!tracked)
                return;
            // consented close (4000) or no onDrop defined — permanent leave
            if (code === 4000 || !options.onDrop) {
                evictClient(state, tracked, room, options.onLeave);
                return;
            }
            // non-consented disconnect — mark as disconnected, fire onDrop
            tracked.socket = null;
            const onDrop = options.onDrop;
            (async () => {
                // fire onDrop — room code may call allowReconnection inside
                await Promise.resolve(onDrop(room, createClient(tracked), code));
                // if allowReconnection was NOT called (no timer set), evict immediately
                if (!tracked.disconnectTimer) {
                    // check the client is still in the map (not already evicted by something else)
                    if (state.clients.has(tracked.id)) {
                        evictClient(state, tracked, room, options.onLeave);
                    }
                }
            })().catch((err) => {
                state.log.error('onDrop threw unexpectedly', { clientId, err });
            });
        },
    };
    return transport.listen(handlers, { port: options.port }).then((server) => {
        state.server = server;
        return { port: server.port, room };
    });
}
async function stopRoom(state, selfInitiated, room, onShutdown, onLeave) {
    if (!state.alive)
        return;
    state.alive = false;
    // remove SIGTERM handler to prevent listener leak
    if (state.sigtermHandler) {
        process.removeListener('SIGTERM', state.sigtermHandler);
        state.sigtermHandler = null;
    }
    if (state.heartbeatInterval) {
        clearInterval(state.heartbeatInterval);
        state.heartbeatInterval = null;
    }
    if (onShutdown) {
        await Promise.resolve(onShutdown());
    }
    // snapshot all tracked clients and clear the map before closing sockets.
    // clearing first prevents the transport's close handler from running
    // eviction logic (it bails early when the client isn't in the map).
    const trackedClients = Array.from(state.clients.values());
    state.clients.clear();
    state.sessionTokens.clear();
    // fire onLeave for each client and clean up
    for (const tracked of trackedClients) {
        // cancel any pending disconnect timer
        if (tracked.disconnectTimer) {
            clearTimeout(tracked.disconnectTimer);
            tracked.disconnectTimer = null;
        }
        // clear reliable buffer
        tracked.reliableBuffer.length = 0;
        tracked.reliableBufferBytes = 0;
        // fire onLeave
        if (onLeave && room) {
            safeCall(state.log, 'onLeave', () => onLeave(room, createClient(tracked)));
        }
        // notify driver
        state.ipc?.send({ type: 'client-disconnected', clientId: tracked.id });
        // close socket
        tracked.socket?.close(1001, 'room shutting down');
    }
    // close transport server
    if (state.server) {
        state.server.close();
        state.server = null;
    }
    // tell server we stopped intentionally so it can remove from desired state
    if (selfInitiated) {
        state.ipc?.send({ type: 'stopped' });
    }
    state.ipc?.close();
}
// env vars that indicate a managed server context
const MANAGED_ENV_KEYS = [
    'GATHO_SOCKET',
    'GATHO_ROOM_ID',
    'GATHO_ROOM_TYPE',
    'GATHO_ROOM_SECRET',
    'GATHO_SERVER_ID',
];
async function start(options) {
    // --- resolve managed context ---
    const presentEnvKeys = MANAGED_ENV_KEYS.filter((k) => process.env[k] !== undefined);
    const hasServerOption = options.server !== undefined;
    let server;
    let roomId;
    let roomType;
    let socketPath;
    let roomSecret;
    let serverId;
    if (options.standalone === true) {
        // pure standalone — ignore all managed config
        if (hasServerOption || presentEnvKeys.length > 0) {
            const bits = [
                hasServerOption ? 'options.server' : null,
                presentEnvKeys.length > 0 ? `env vars (${presentEnvKeys.join(', ')})` : null,
            ].filter(Boolean).join(' and ');
            createLogger().warn(`gatho/room: standalone: true is set, ignoring managed context from ${bits}`);
        }
        server = undefined;
        roomId = randomUUID();
        roomType = 'room';
        socketPath = undefined;
        roomSecret = null;
        serverId = undefined;
    }
    else {
        server = options.server;
        roomId = server?.roomId ?? process.env.GATHO_ROOM_ID ?? randomUUID();
        roomType = server?.roomType ?? process.env.GATHO_ROOM_TYPE ?? 'room';
        socketPath = server?.socket ?? process.env.GATHO_SOCKET;
        roomSecret = server?.roomSecret ?? process.env.GATHO_ROOM_SECRET ?? null;
        serverId = server?.serverId ?? process.env.GATHO_SERVER_ID;
        // fail closed: require managed context OR explicit standalone opt-in.
        // this prevents accidentally running a room with no auth in production.
        if (!socketPath && !roomSecret) {
            throw new Error('gatho/room start(): no managed server context detected ' +
                '(no GATHO_SOCKET / GATHO_ROOM_SECRET, and no options.server.socket / roomSecret). ' +
                'If running this room directly for local dev or tests, pass `standalone: true`. ' +
                'Otherwise ensure the gatho server spawned this process so GATHO_* env vars are set.');
        }
    }
    // set up ipc if socket path is present (managed mode)
    let ipc = null;
    if (socketPath) {
        const conn = await connectToSocket(socketPath);
        ipc = {
            send(msg) {
                conn.send(msg);
            },
            close() {
                conn.close();
            },
        };
    }
    const log = createLogger().child({ roomId, roomType });
    const state = {
        roomId,
        roomType,
        serverId,
        roomSecret,
        clients: new Map(),
        sessionTokens: new Map(),
        ipc,
        heartbeatInterval: null,
        alive: true,
        server: null,
        sigtermHandler: null,
        log,
    };
    const transport = options.transport ?? wsTransport();
    const { port, room } = await startRoom(state, transport, {
        port: options.port,
        maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
        onAuth: options.onAuth,
        onJoin: options.onJoin,
        onMessage: options.onMessage,
        onLeave: options.onLeave,
        onDrop: options.onDrop,
        onReconnect: options.onReconnect,
        onShutdown: options.onShutdown,
    });
    if (ipc) {
        startHeartbeat(state);
        ipc.send({ type: 'ready', port });
    }
    const sigtermHandler = () => {
        stopRoom(state, false, room, options.onShutdown, options.onLeave).catch((err) => {
            state.log.error('error during shutdown', { err });
        });
    };
    state.sigtermHandler = sigtermHandler;
    process.on('SIGTERM', sigtermHandler);
    return room;
}

// gatho/room — room-side api
// rooms are scripts. user initializes state in module scope, calls start()
// which returns a Room handle. no defineRoom, no hook bags, no RoomContext.
// --- close codes ---
// websocket close codes that gatho uses to distinguish disconnect reasons.
// 4000 (CONSENTED) = the client explicitly called close() — sent __leave first.
// everything else fires onDrop, giving the room code a chance to call allowReconnection.
const CloseCode = {
    NORMAL: 1000,
    GOING_AWAY: 1001,
    ABNORMAL: 1006,
    CONSENTED: 4000,
};
// helpers for returning auth results with correct literal types
// avoids the user needing `as const` on every return
const auth = {
    ok(data = {}) {
        return { ok: true, data };
    },
    fail(error) {
        return { ok: false, error };
    },
};

export { CloseCode, auth, start, wsTransport };
//# sourceMappingURL=room.js.map
