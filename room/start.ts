import { randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify } from '../common/jwt';
import type { Logger } from '../common/logger';
import { createLogger } from '../common/logger';
import type { RoomMessage } from '../common/uds';
import { connectToSocket } from './ipc';
import type { AuthResult, Client, ClientCollection, Room, SendOptions } from './index';
import type { ClientSocket, Transport, TransportHandlers, TransportServer } from './transport/types';
import { wsTransport } from './transport/ws';
import { unpackFrame, packProtocol, packUserText, packUserBinary } from '../common/protocol';

// frame a user message for the wire. strings become [0x01, ...utf8],
// binary becomes [0x02, ...raw bytes]. ArrayBufferView is normalized to Uint8Array.
function frameUserMessage(msg: string | ArrayBuffer | ArrayBufferView): Uint8Array {
    if (typeof msg === 'string') return packUserText(msg);
    if (msg instanceof ArrayBuffer) return packUserBinary(msg);
    // ArrayBufferView (Uint8Array, Float32Array, etc.)
    return packUserBinary(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
}

const HEARTBEAT_INTERVAL_MS = 3000;

function safeCall(log: Logger, label: string, fn: () => void | Promise<void>): void {
    Promise.resolve()
        .then(fn)
        .catch((err) => {
            log.error(`${label} threw unexpectedly`, { err });
        });
}

type IpcConnection = {
    send(msg: RoomMessage): void;
    close(): void;
};

type TrackedClient = {
    id: string;
    data: unknown;
    socket: ClientSocket | null;
    sessionToken: string;
    reliableBuffer: BufferedMessage[];
    reliableBufferBytes: number;
    disconnectTimer: ReturnType<typeof setTimeout> | null;
};

type BufferedMessage = {
    payload: Uint8Array;
    byteSize: number;
};

type RoomState = {
    roomId: string;
    roomType: string;
    serverId: string | undefined;
    roomSecret: string | null;
    clients: Map<string, TrackedClient>;
    sessionTokens: Map<string, string>; // token -> clientId
    ipc: IpcConnection | null;
    heartbeatInterval: ReturnType<typeof setInterval> | null;
    alive: boolean;
    server: TransportServer | null;
    sigtermHandler: (() => void) | null;
    log: Logger;
};

// topic used for pub/sub broadcast
const BROADCAST_TOPIC = 'room';

// --- start options ---

/** server-managed config passed to `start()`. all fields fall back to `GATHO_*` env vars.
 *  when the server spawns a room process, it sets these env vars automatically.
 *  you can also pass them explicitly for custom setups. */
export type ServerConfig = {
    /** uds socket path — falls back to `GATHO_SOCKET`.
     *  presence of this (from option or env) triggers ipc connection,
     *  heartbeats, and ready signal to the parent server. */
    socket?: string;

    /** room identity — falls back to `GATHO_ROOM_ID`. */
    roomId?: string;

    /** room type — falls back to `GATHO_ROOM_TYPE`. */
    roomType?: string;

    /** per-room jwt secret — falls back to `GATHO_ROOM_SECRET`.
     *  controls jwt verification of client tokens. */
    roomSecret?: string;

    /** server identity — falls back to `GATHO_SERVER_ID`. */
    serverId?: string;
};

/** options for starting a room via `start()`.
 *
 *  two modes depending on whether a server is managing this room:
 *
 *  - **managed mode** — room is spawned by `createServer()`. the server sets
 *    `GATHO_*` env vars automatically. ipc connects to the parent for heartbeats,
 *    ready signals, and client tracking.
 *
 *  - **standalone mode** — no server, no `GATHO_*` env vars. the room runs
 *    independently with a random roomId and no ipc. great for local dev and tests.
 *
 *  generic parameters:
 *  - `ClientData` — the data shape returned by `onAuth` via `auth.ok(data)`.
 *    inferred from the return type of `onAuth`.
 *  - `JoinData` — the data shape passed to `onAuth`. matches the `data` bag
 *    from `sdk.join({ data })`. annotate the `onAuth` parameter to opt in. */
export type StartOptions<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>> = {
    /** server-managed config. when provided, fields override `GATHO_*` env vars.
     *  when omitted, env vars are still checked — if `GATHO_SOCKET` is set
     *  in the environment, the room connects ipc automatically.
     *  in standalone mode (no server config, no env vars), roomId defaults
     *  to a random uuid and roomType defaults to `'room'`. */
    server?: ServerConfig;

    /** port for the ws server. `0` = os-assigned (default).
     *  in managed mode this is typically left as 0 since the server
     *  discovers the port via the ipc `ready` message. */
    port?: number;

    /** transport for the ws server. defaults to `wsTransport()` (the `ws` npm package).
     *  swap this out for a custom transport (e.g. uWebSockets.js) if needed. */
    transport?: Transport;

    /** per-client reliable message buffer cap in bytes. when a disconnected client's
     *  buffer exceeds this, the client is evicted. default: 1MB (1_048_576). */
    maxBufferBytes?: number;

    /** auth handler — called for every new connection.
     *  return `auth.ok(data)` to accept (data becomes `client.data`),
     *  or `auth.fail(reason)` to reject.
     *  if omitted, all connections are accepted with empty client data.
     *
     *  `joinData` is the arbitrary data bag from `sdk.join({ data })`, or `{}` if omitted.
     *  `room` gives access to current room state (e.g. `room.clients.count()` for capacity checks).
     *  annotate the joinData parameter to get type inference:
     *  ```ts
     *  onAuth: (room, joinData: { displayName?: string }) =>
     *    auth.ok({ username: joinData.displayName ?? 'anon' })
     *  ``` */
    onAuth?: (room: Room<unknown>, joinData: JoinData) => AuthResult<ClientData> | Promise<AuthResult<ClientData>>;

    /** fires after a client is authenticated and added to the room. */
    onJoin?: (room: Room<NoInfer<ClientData>>, client: Client<NoInfer<ClientData>>) => void | Promise<void>;

    /** fires when a connected client sends a websocket message.
     *  text frames arrive as `string`, binary frames as `ArrayBuffer`. */
    onMessage?: (
        room: Room<NoInfer<ClientData>>,
        client: Client<NoInfer<ClientData>>,
        message: string | ArrayBuffer,
    ) => void | Promise<void>;

    /** fires when a client permanently leaves the room (consented close,
     *  reconnection window expired, or eviction). */
    onLeave?: (room: Room<NoInfer<ClientData>>, client: Client<NoInfer<ClientData>>) => void | Promise<void>;

    /** fires on non-consented disconnect (close code != 4000).
     *  call `room.allowReconnection(client, ms)` inside to hold the seat
     *  for the given duration. if you don't call it, the client is evicted
     *  immediately. if `onDrop` is not defined, all disconnects are permanent. */
    onDrop?: (room: Room<NoInfer<ClientData>>, client: Client<NoInfer<ClientData>>, code: number) => void | Promise<void>;

    /** fires when a previously-dropped client reconnects within their
     *  reconnection window. buffered reliable messages are flushed automatically
     *  before this callback runs. */
    onReconnect?: (room: Room<NoInfer<ClientData>>, client: Client<NoInfer<ClientData>>) => void | Promise<void>;

    /** fires on SIGTERM or `room.stop()`. after this returns (or if not provided),
     *  all connections are closed and the room shuts down. */
    onShutdown?: () => void | Promise<void>;
};

function createClient<ClientData>(tracked: TrackedClient): Client<ClientData> {
    return { id: tracked.id, data: tracked.data as ClientData };
}

function createClientCollection<ClientData>(clients: Map<string, TrackedClient>): ClientCollection<ClientData> {
    return {
        get(id: string) {
            const c = clients.get(id);
            if (!c) return undefined;
            return createClient<ClientData>(c);
        },
        has(id: string) {
            return clients.has(id);
        },
        count() {
            return clients.size;
        },
        forEach(callback) {
            for (const [id, c] of clients) {
                callback(createClient<ClientData>(c), id);
            }
        },
        ids() {
            return Array.from(clients.keys());
        },
        all() {
            return Array.from(clients.values()).map((c) => createClient<ClientData>(c));
        },
    };
}

// default per-client reliable message buffer cap: 1mb
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576;

// permanently remove a client — cancel timers, invalidate session token,
// fire onLeave, notify driver. used on reconnect window expiry, buffer overflow,
// consented close, and disconnect without allowReconnection.
function evictClient<ClientData>(
    state: RoomState,
    tracked: TrackedClient,
    room: Room<ClientData>,
    onLeave?: (room: Room<ClientData>, client: Client<ClientData>) => void | Promise<void>,
): void {
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
        safeCall(state.log, 'onLeave', () => onLeave(room, createClient<ClientData>(tracked)));
    }

    // notify driver
    state.ipc?.send({ type: 'client-disconnected', clientId: tracked.id });
}

function createRoom<ClientData>(
    state: RoomState,
    maxBufferBytes: number,
    callbacks: {
        onLeave?: (room: Room<ClientData>, client: Client<ClientData>) => void | Promise<void>;
        onShutdown?: () => void | Promise<void>;
    },
): Room<ClientData> {
    let room: Room<ClientData>;

    // buffer a reliable message for a disconnected client.
    // if byte cap exceeded, evict the client.
    function bufferForClient(tracked: TrackedClient, payload: Uint8Array): void {
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
        send(client: Client<ClientData>, message: string | ArrayBuffer | ArrayBufferView, options?: SendOptions) {
            if (!state.alive) return;
            const tracked = state.clients.get(client.id);
            if (!tracked) return;

            const framed = frameUserMessage(message);
            const reliable = options?.reliable !== false;

            if (tracked.socket) {
                tracked.socket.send(framed, true);
            } else if (reliable) {
                bufferForClient(tracked, framed);
            }
        },
        broadcast(message: string | ArrayBuffer | ArrayBufferView, options?: SendOptions) {
            if (!state.alive) return;
            if (!state.server) return;

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
            return createClientCollection<ClientData>(state.clients);
        },
        allowReconnection(client: Client<ClientData>, windowMs: number) {
            const tracked = state.clients.get(client.id);
            if (!tracked) return;
            // only meaningful when the client is disconnected
            if (tracked.socket) return;

            // set up the disconnect timer — when it fires, the client is evicted
            tracked.disconnectTimer = setTimeout(() => {
                tracked.disconnectTimer = null;
                evictClient(state, tracked, room, callbacks.onLeave);
            }, windowMs);
        },
        disconnect(client: Client<ClientData>) {
            const tracked = state.clients.get(client.id);
            if (!tracked) return;

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

function startHeartbeat(state: RoomState): void {
    if (!state.ipc) return;

    const ipc = state.ipc;
    state.heartbeatInterval = setInterval(() => {
        if (!state.alive) return;

        // collect ids of clients with an active socket — these are the
        // ground truth for who is connected. clients in the reconnection
        // window (socket === null) have already been reported as disconnected.
        const clientIds: string[] = [];
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

function startRoom<ClientData, JoinData extends Record<string, unknown>>(
    state: RoomState,
    transport: Transport,
    options: {
        port?: number;
        maxBufferBytes: number;
        onAuth?: (room: Room<unknown>, joinData: JoinData) => AuthResult<ClientData> | Promise<AuthResult<ClientData>>;
        onJoin?: (room: Room<ClientData>, client: Client<ClientData>) => void | Promise<void>;
        onMessage?: (room: Room<ClientData>, client: Client<ClientData>, message: string | ArrayBuffer) => void | Promise<void>;
        onLeave?: (room: Room<ClientData>, client: Client<ClientData>) => void | Promise<void>;
        onDrop?: (room: Room<ClientData>, client: Client<ClientData>, code: number) => void | Promise<void>;
        onReconnect?: (room: Room<ClientData>, client: Client<ClientData>) => void | Promise<void>;
        onShutdown?: () => void | Promise<void>;
    },
): Promise<{ port: number; room: Room<ClientData> }> {
    // the room handle is created once and shared — same object passed to callbacks
    // and returned from start()
    const room = createRoom<ClientData>(state, options.maxBufferBytes, {
        onLeave: options.onLeave,
        onShutdown: options.onShutdown,
    });

    const handlers: TransportHandlers = {
        upgrade(query: string) {
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
                if (!token) return null;

                const payload = jwtVerify(token, state.roomSecret);
                if (!payload) return null;

                const clientId = payload.clientId as string;
                const roomId = payload.roomId as string;
                const joinData = (payload.data as Record<string, unknown> | undefined) ?? {};

                // verify the token is for this room
                if (roomId !== state.roomId) return null;

                return { clientId, joinData };
            }

            // dev mode — no jwt verification, generate identity
            return { clientId: randomUUID(), joinData: {} };
        },

        open(clientId: string, socket: ClientSocket, joinData: Record<string, unknown>) {
            socket.subscribe(BROADCAST_TOPIC);

            (async () => {
                let result: AuthResult<ClientData>;
                try {
                    result = await Promise.resolve(
                        options.onAuth ? options.onAuth(room, joinData as JoinData) : { ok: true, data: {} as ClientData },
                    );
                } catch (err) {
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
                const tracked: TrackedClient = {
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
                    await Promise.resolve(options.onJoin(room, createClient<ClientData>(tracked)));
                }
            })().catch((err) => {
                state.log.error('onJoin threw unexpectedly', { clientId, err });
            });
        },

        message(clientId: string, data: ArrayBuffer, _isBinary: boolean) {
            const tracked = state.clients.get(clientId);
            if (!tracked?.socket) return;

            const frame = unpackFrame(data);

            if (frame.frame === 'protocol') {
                if (frame.message.type === 'leave') {
                    tracked.socket.close(4000, 'consented leave');
                }
                return;
            }

            if (options.onMessage) {
                if (frame.frame === 'user_text') {
                    safeCall(state.log, 'onMessage', () =>
                        options.onMessage!(room, createClient<ClientData>(tracked), frame.text),
                    );
                } else {
                    safeCall(state.log, 'onMessage', () =>
                        options.onMessage!(room, createClient<ClientData>(tracked), frame.data),
                    );
                }
            }
        },

        reconnect(clientId: string, socket: ClientSocket) {
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
                safeCall(state.log, 'onReconnect', () => options.onReconnect!(room, createClient<ClientData>(tracked)));
            }

            // notify driver: client is connected again
            state.ipc?.send({ type: 'client-connected', clientId });
        },

        close(clientId: string, code: number) {
            const tracked = state.clients.get(clientId);
            if (!tracked) return;

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
                await Promise.resolve(onDrop(room, createClient<ClientData>(tracked), code));

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

async function stopRoom<ClientData>(
    state: RoomState,
    selfInitiated: boolean,
    room: Room<ClientData> | null,
    onShutdown?: () => void | Promise<void>,
    onLeave?: (room: Room<ClientData>, client: Client<ClientData>) => void | Promise<void>,
): Promise<void> {
    if (!state.alive) return;

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
            safeCall(state.log, 'onLeave', () => onLeave(room, createClient<ClientData>(tracked)));
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

export async function start<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>>(
    options: StartOptions<ClientData, JoinData>,
): Promise<Room<ClientData>> {
    // resolve config: server object > env vars > standalone defaults
    const server = options.server;
    const roomId = server?.roomId ?? process.env.GATHO_ROOM_ID ?? randomUUID();
    const roomType = server?.roomType ?? process.env.GATHO_ROOM_TYPE ?? 'room';
    const socketPath = server?.socket ?? process.env.GATHO_SOCKET;
    const roomSecret = server?.roomSecret ?? process.env.GATHO_ROOM_SECRET ?? null;
    const serverId = server?.serverId ?? process.env.GATHO_SERVER_ID;

    // set up ipc if socket path is present (managed mode)
    let ipc: IpcConnection | null = null;

    if (socketPath) {
        const conn = await connectToSocket(socketPath);

        ipc = {
            send(msg: RoomMessage) {
                conn.send(msg);
            },
            close() {
                conn.close();
            },
        };
    }

    const log = createLogger().child({ roomId, roomType });

    const state: RoomState = {
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

    const { port, room } = await startRoom<ClientData, JoinData>(state, transport, {
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
