import { jwtVerify } from '../common/jwt';
import { createLogger, type Logger } from '../common/logger';
import type { Notifier, ProcessMetricsMessage } from '../common/notify-protocol';
import { frameUserMessage, PROTOCOL_VERSION, packProtocol, unpackFrame } from '../common/protocol';
import type { AuthResult, Client, ClientCollection, Room, SendOptions } from './index';
import { connectNotify, parseNotifyTarget } from './ipc';
import type { ClientSocket, Transport, TransportHandlers, TransportServer } from './transport/types';
import { wsTransport } from './transport/ws';

const HEARTBEAT_INTERVAL_MS = 3000;

// --- runtime-neutral helpers ---
// the room engine runs in node, bun, deno, and workerd isolates. node-only
// surfaces (process env/metrics/signals, node:net) are feature-detected or
// lazily imported; entropy comes from webcrypto.

function readEnv(key: string): string | undefined {
    return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}

function randomHex(byteLength: number): string {
    const buf = new Uint8Array(byteLength);
    crypto.getRandomValues(buf);
    let hex = '';
    for (const b of buf) hex += b.toString(16).padStart(2, '0');
    return hex;
}

function safeCall(log: Logger, label: string, fn: () => void | Promise<void>): void {
    Promise.resolve()
        .then(fn)
        .catch((err) => {
            log.error(`${label} threw unexpectedly`, { err });
        });
}

type TrackedClient = {
    id: string;
    data: unknown;
    socket: ClientSocket | null;
    sessionToken: string;
    reliableBuffer: BufferedMessage[];
    reliableBufferBytes: number;
    disconnectTimer: ReturnType<typeof setTimeout> | null;
    // driver-internal tags forwarded from the reservation jwt. opaque to
    // user code — echoed back over ipc on client-connected/heartbeat so
    // the server can pass them to driver.connectClient. enables self-heal
    // if the driver's client record was evicted between reserve and connect.
    tags: Record<string, string>;
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
    ipc: Notifier | null;
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
    /** notify channel back to the managing server — either a `Notifier` object
     *  (when the room is hosted in the same process as something that can hand
     *  it one) or a string: `uds:<path>`, `tcp://host:port?token=…`, or a bare
     *  filesystem path (treated as a uds socket path). falls back to
     *  `GATHO_NOTIFY_SOCKET`. presence of either (option or env) triggers
     *  managed mode: heartbeats, ready signal, and client tracking to the
     *  parent server. */
    notify?: Notifier | string;

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
 *  two modes depending on how the room is invoked:
 *
 *  - **managed mode** (default when `GATHO_*` env vars or `options.server` are present) —
 *    the server spawns the room and sets `GATHO_*` env vars, or you pass the same
 *    values via `options.server`. ipc connects to the parent for heartbeats, ready
 *    signals, and client tracking. client connections are authenticated via the
 *    seat-token jwt.
 *
 *  - **standalone mode** (opt-in via `standalone: true`) — the room runs independently
 *    with a random roomId, no ipc, and no jwt verification. accepts any connection.
 *    useful for local dev and tests. `start()` throws if no managed context is
 *    detected and `standalone` is not explicitly set — this prevents accidentally
 *    deploying a room that silently skips auth.
 *
 *  generic parameters:
 *  - `ClientData` — the data shape returned by `onAuth` via `auth.ok(data)`.
 *    inferred from the return type of `onAuth`.
 *  - `JoinData` — the data shape passed to `onAuth`. matches the `data` bag
 *    from `sdk.join({ data })`. annotate the `onAuth` parameter to opt in. */
export type StartOptions<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>> = {
    /** server-managed config. when provided, fields override `GATHO_*` env vars.
     *  when omitted, env vars are checked instead — if `GATHO_NOTIFY_SOCKET` is
     *  set, the room connects its notify channel automatically. mutually
     *  exclusive with `standalone`. */
    server?: ServerConfig;

    /** explicit opt-in to run without a managed server context. required when
     *  neither `GATHO_NOTIFY_SOCKET`/`GATHO_ROOM_SECRET` env vars are set nor
     *  `options.server.notify`/`options.server.roomSecret` are provided —
     *  otherwise `start()` throws. when `true`, all managed config (env vars and
     *  `options.server`) is ignored; a warning is logged if any was present. */
    standalone?: boolean;

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

        // collect clients with an active socket — these are the ground truth
        // for who is connected. clients in the reconnection window
        // (socket === null) have already been reported as disconnected.
        // include tags so the server's reconciler has the same context as the
        // fast path; otherwise the reconciler's connectClient call would
        // resurrect a partially-evicted driver record without tags.
        const clients: { clientId: string; tags: Record<string, string> }[] = [];
        for (const [id, tracked] of state.clients) {
            if (tracked.socket !== null) {
                clients.push({ clientId: id, tags: tracked.tags });
            }
        }

        // process metrics are node/bun-only — omitted where the runtime can't
        // report them (e.g. workerd isolates). the wire schema marks them optional.
        let metrics: ProcessMetricsMessage | undefined;
        if (
            typeof process !== 'undefined' &&
            typeof process.memoryUsage === 'function' &&
            typeof process.cpuUsage === 'function'
        ) {
            const mem = process.memoryUsage();
            const cpu = process.cpuUsage();
            metrics = {
                memoryRss: mem.rss,
                memoryHeapUsed: mem.heapUsed,
                memoryHeapTotal: mem.heapTotal,
                cpuUser: cpu.user,
                cpuSystem: cpu.system,
            };
        }

        ipc.send({
            type: 'heartbeat',
            timestamp: Date.now(),
            metrics,
            clients,
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
        async upgrade(query: string) {
            const params = new URLSearchParams(query);

            // protocol version handshake — client and server gatho versions
            // must match exactly. missing or mismatched `gv` completes the
            // upgrade anyway (so the client gets a readable auth_error frame
            // rather than a raw 4xx, same rationale as the invalid-session
            // path below) then closes 4000 in open()/reconnect().
            const gvParam = params.get('gv');
            const clientVersion = gvParam === null ? 'none' : gvParam;
            if (clientVersion !== String(PROTOCOL_VERSION)) {
                const versionMismatch = `protocol version mismatch (client ${clientVersion}, server ${PROTOCOL_VERSION})`;
                // a reconnect carries a session param — thread the marker through
                // whichever handler the transport will call so the message lands.
                if (params.get('session')) {
                    return { clientId: crypto.randomUUID(), reconnecting: true, versionMismatch };
                }
                return { clientId: crypto.randomUUID(), versionMismatch };
            }

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

                const payload = await jwtVerify(token, state.roomSecret);
                if (!payload) return null;

                const clientId = payload.clientId as string;
                const roomId = payload.roomId as string;
                const joinData = (payload.data as Record<string, unknown> | undefined) ?? {};
                const tags = (payload.tags as Record<string, string> | undefined) ?? {};

                // verify the token is for this room
                if (roomId !== state.roomId) return null;

                return { clientId, joinData, tags };
            }

            // dev mode — no jwt verification, generate identity
            return { clientId: crypto.randomUUID(), joinData: {}, tags: {} };
        },

        open(
            clientId: string,
            socket: ClientSocket,
            joinData: Record<string, unknown>,
            tags: Record<string, string>,
            versionMismatch?: string,
        ) {
            // reject a protocol-version-mismatched client with a readable error
            // before doing any auth or state work.
            if (versionMismatch) {
                socket.send(packProtocol({ type: 'auth_error', error: versionMismatch }), true);
                socket.close(4000, 'protocol version mismatch');
                return;
            }

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
                const sessionToken = randomHex(16);
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
                    tags,
                };
                state.clients.set(clientId, tracked);

                // subscribe to broadcasts only now that auth has passed — a
                // rejected client must never be subscribed, and broadcasts sent
                // during a slow async onAuth must not reach an unauthenticated socket.
                socket.subscribe(BROADCAST_TOPIC);

                // send session token to client
                socket.send(packProtocol({ type: 'session', token: sessionToken, clientId }), true);

                // notify server for driver bookkeeping (managed mode only).
                // forward roomId + tags so driver.connectClient can perform a
                // full upsert — covers the case where the driver's client
                // record was evicted between reserveClient and now.
                state.ipc?.send({ type: 'client-connected', clientId, roomId: state.roomId, tags });

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

        reconnect(clientId: string, socket: ClientSocket, versionMismatch?: string) {
            // reject a protocol-version-mismatched client with a readable error
            // before touching reconnection state.
            if (versionMismatch) {
                socket.send(packProtocol({ type: 'auth_error', error: versionMismatch }), true);
                socket.close(4000, 'protocol version mismatch');
                return;
            }

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
            const newToken = randomHex(16);
            tracked.sessionToken = newToken;
            state.sessionTokens.set(newToken, clientId);

            // flush reliable buffer to client (FIFO)
            for (const buffered of tracked.reliableBuffer) {
                socket.send(buffered.payload, true);
            }
            tracked.reliableBuffer.length = 0;
            tracked.reliableBufferBytes = 0;

            // send new session token — this is the "reconnection handshake complete" signal
            socket.send(packProtocol({ type: 'session', token: newToken, clientId }), true);

            // fire onReconnect
            if (options.onReconnect) {
                safeCall(state.log, 'onReconnect', () => options.onReconnect!(room, createClient<ClientData>(tracked)));
            }

            // notify driver: client is connected again. forward roomId + the
            // tags we cached at original open() — same upsert path as fast.
            state.ipc?.send({ type: 'client-connected', clientId, roomId: state.roomId, tags: tracked.tags });
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

// env vars that indicate a managed server context
const MANAGED_ENV_KEYS = [
    'GATHO_NOTIFY_SOCKET',
    'GATHO_ROOM_ID',
    'GATHO_ROOM_TYPE',
    'GATHO_ROOM_SECRET',
    'GATHO_SERVER_ID',
] as const;

export async function start<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>>(
    options: StartOptions<ClientData, JoinData>,
): Promise<Room<ClientData>> {
    // --- resolve managed context ---

    const presentEnvKeys = MANAGED_ENV_KEYS.filter((k) => readEnv(k) !== undefined);
    const hasServerOption = options.server !== undefined;

    let server: ServerConfig | undefined;
    let roomId: string;
    let roomType: string;
    let notifySource: Notifier | string | undefined;
    let roomSecret: string | null;
    let serverId: string | undefined;

    if (options.standalone === true) {
        // pure standalone — ignore all managed config
        if (hasServerOption || presentEnvKeys.length > 0) {
            const bits = [
                hasServerOption ? 'options.server' : null,
                presentEnvKeys.length > 0 ? `env vars (${presentEnvKeys.join(', ')})` : null,
            ]
                .filter(Boolean)
                .join(' and ');
            createLogger().warn(`gatho/room: standalone: true is set, ignoring managed context from ${bits}`);
        }
        server = undefined;
        roomId = crypto.randomUUID();
        roomType = 'room';
        notifySource = undefined;
        roomSecret = null;
        serverId = undefined;
    } else {
        server = options.server;
        roomId = server?.roomId ?? readEnv('GATHO_ROOM_ID') ?? crypto.randomUUID();
        roomType = server?.roomType ?? readEnv('GATHO_ROOM_TYPE') ?? 'room';
        roomSecret = server?.roomSecret ?? readEnv('GATHO_ROOM_SECRET') ?? null;
        serverId = server?.serverId ?? readEnv('GATHO_SERVER_ID');

        // notify channel resolution: explicit option → GATHO_NOTIFY_SOCKET
        // (a `uds:`/`tcp://` uri, or a bare uds socket path)
        notifySource = server?.notify ?? readEnv('GATHO_NOTIFY_SOCKET');

        // fail closed: require managed context OR explicit standalone opt-in.
        // this prevents accidentally running a room with no auth in production.
        if (!notifySource && !roomSecret) {
            throw new Error(
                'gatho/room start(): no managed server context detected ' +
                    '(no GATHO_NOTIFY_SOCKET / GATHO_ROOM_SECRET env vars, and no options.server.notify / roomSecret). ' +
                    'If running this room directly for local dev or tests, pass `standalone: true`. ' +
                    'Otherwise ensure the gatho server spawned this process so GATHO_* env vars are set.',
            );
        }
    }

    // set up the notify link (managed mode). a Notifier object is used as-is
    // (in-process hosting); a uri string is dialed over uds/tcp — node:net is
    // loaded lazily inside the dialer, so non-node bundles that always pass a
    // Notifier object never execute a node import.
    let ipc: Notifier | null = null;

    if (typeof notifySource === 'string') {
        ipc = await connectNotify(parseNotifyTarget(notifySource));
    } else if (notifySource) {
        ipc = notifySource;
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

    // signal handling belongs to whoever owns the process — install only where
    // there is one (node/bun/deno; workerd isolates have no signals).
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
        const sigtermHandler = () => {
            stopRoom(state, false, room, options.onShutdown, options.onLeave).catch((err) => {
                state.log.error('error during shutdown', { err });
            });
        };
        state.sigtermHandler = sigtermHandler;
        process.on('SIGTERM', sigtermHandler);
    }

    return room;
}
