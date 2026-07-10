// gatho workerd room adapter (example code — public API only)
//
// Implements the gatho room-side `Transport` contract over workerd's
// `WebSocketPair`, and wraps a room options module as an `ExportedHandler` that
// the harness loads into a v8 isolate via the `workerLoader` binding.
//
// The room engine (`start` from 'gatho/room') is runtime-neutral: we hand it a
// custom transport and a `Notifier` OBJECT, so it never touches node:net, ws, or
// http.
//
// THE workerd CONSTRAINT that shapes everything here: I/O objects (WebSockets,
// TCP streams) are bound to the request context that created them and cannot be
// used from a different context. A gatho room broadcasts — one client's message
// triggers sends to *every* client's socket — which naively means sending on
// sockets accepted in other requests. workerd forbids that. Durable Objects (the
// usual fix) aren't available to dynamically-loaded workers.
//
// So: each connection owns a small outbox + a drain loop that runs in that
// connection's OWN request context (kept alive with `waitUntil` until the socket
// closes). The engine never calls `ws.send`/`ws.close` directly — `ClientSocket`
// just pushes onto the target connection's outbox and signals its loop, which
// performs the actual I/O in the one context where that socket is valid. This
// makes send/echo/broadcast all work within a single isolate. See README.

import type { ClientSocket, Transport, TransportHandlers, TransportServer } from 'gatho/room';
import { type NotifyMessage, type StartOptions, start } from 'gatho/room';

// workerd globals — declared loosely to avoid a dependency on @cloudflare/workers-types.
declare const WebSocketPair: {
    new (): { 0: WorkerWebSocket; 1: WorkerWebSocket };
};
type WorkerWebSocket = {
    accept(): void;
    send(data: string | ArrayBuffer | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'message', cb: (e: { data: string | ArrayBuffer }) => void): void;
    addEventListener(type: 'close', cb: (e: { code: number; reason: string }) => void): void;
    addEventListener(type: 'error', cb: (e: unknown) => void): void;
};

type NotifierBinding = { notify(json: string): Promise<void> | void };

/** the room isolate's `env` — the WorkerCode.env the harness supplies. */
export type RoomEnv = {
    GATHO_ROOM_ID: string;
    GATHO_ROOM_TYPE: string;
    GATHO_ROOM_SECRET: string;
    GATHO_SERVER_ID: string;
    GATHO_CLIENT_PORT: string;
    NOTIFIER: NotifierBinding;
};

type ExecutionContext = { waitUntil(p: Promise<unknown>): void };

type OutboundData = string | ArrayBuffer | Uint8Array;

// per-connection state. `ws` is only ever touched by this connection's own drain
// loop (running in the context that accepted it).
type Conn = {
    clientId: string;
    ws: WorkerWebSocket;
    topics: Set<string>;
    tags: Record<string, string>;
    outbox: OutboundData[];
    closeRequest: { code: number; reason: string } | null;
    closed: boolean;
    wake: Promise<void>;
    signal: () => void;
};

function armConn(conn: Conn): void {
    conn.wake = new Promise<void>((res) => {
        conn.signal = res;
    });
}

class WorkerdRoom {
    private startPromise: Promise<void> | null = null;

    private handlers: TransportHandlers | null = null;
    private clientPort = 0;
    private conns = new Map<string, Conn>(); // clientId -> conn
    private topics = new Map<string, Set<string>>(); // topic -> clientIds
    private outbox: NotifyMessage[] = []; // notify messages queued for the next flush

    constructor(private def: StartOptions<unknown, Record<string, unknown>>) {}

    // --- lifecycle ---

    private ensureStarted(env: RoomEnv): Promise<void> {
        if (this.startPromise) return this.startPromise;
        this.clientPort = Number(env.GATHO_CLIENT_PORT);

        const notifier = {
            send: (msg: NotifyMessage) => {
                this.outbox.push(msg);
            },
            close: () => {},
        };

        const transport: Transport = {
            listen: (handlers) => {
                this.handlers = handlers;
                const server: TransportServer = {
                    port: this.clientPort, // rooms are path-routed behind one shared host port
                    publish: (topic, data) => {
                        const subs = this.topics.get(topic);
                        if (!subs) return;
                        for (const id of subs) this.enqueueSend(id, data as OutboundData);
                    },
                    close: () => {
                        for (const conn of this.conns.values()) this.enqueueClose(conn.clientId, 1001, 'room shutting down');
                    },
                };
                return Promise.resolve(server);
            },
        };

        this.startPromise = start({
            ...this.def,
            transport,
            port: 0,
            server: {
                notify: notifier,
                roomId: env.GATHO_ROOM_ID,
                roomType: env.GATHO_ROOM_TYPE,
                roomSecret: env.GATHO_ROOM_SECRET,
                serverId: env.GATHO_SERVER_ID,
            },
        }).then(() => undefined);

        return this.startPromise;
    }

    // --- fetch entry ---

    async fetch(req: Request, env: RoomEnv, ctx: ExecutionContext): Promise<Response> {
        await this.ensureStarted(env);
        const url = new URL(req.url);

        if (req.headers.get('Upgrade') === 'websocket') {
            const res = this.handleUpgrade(url, ctx);
            ctx.waitUntil(this.flush(env.NOTIFIER));
            return res;
        }

        if (url.pathname.endsWith('/__gatho/tick')) {
            this.enqueueHeartbeat();
            ctx.waitUntil(this.flush(env.NOTIFIER));
            return new Response('tick', { status: 200 });
        }

        ctx.waitUntil(this.flush(env.NOTIFIER));
        return new Response(`gatho room ${env.GATHO_ROOM_ID} ok`, { status: 200 });
    }

    private handleUpgrade(url: URL, ctx: ExecutionContext): Response {
        const handlers = this.handlers;
        if (!handlers) return new Response('room not ready', { status: 503 });

        const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();

        const conn: Conn = {
            clientId: '',
            ws: server,
            topics: new Set(),
            tags: {},
            outbox: [],
            closeRequest: null,
            closed: false,
            wake: Promise.resolve(),
            signal: () => {},
        };
        armConn(conn);

        // The drain loop runs in THIS request's context — the only context where
        // `server` is a valid I/O object. `waitUntil` keeps that context (and the
        // socket) alive until the connection closes.
        ctx.waitUntil(this.connLoop(conn));

        // resolve auth, then wire the connection into the engine.
        ctx.waitUntil(
            Promise.resolve(handlers.upgrade(query))
                .then((result) => {
                    if (!result) {
                        conn.closeRequest = { code: 4401, reason: 'unauthorized' };
                        conn.signal();
                        return;
                    }
                    this.wireSocket(conn, handlers, result);
                })
                .catch(() => {
                    conn.closeRequest = { code: 1011, reason: 'internal error' };
                    conn.signal();
                }),
        );

        return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WorkerWebSocket });
    }

    // drains a connection's outbox in its own context; performs the actual send/close.
    private async connLoop(conn: Conn): Promise<void> {
        while (true) {
            while (conn.outbox.length > 0) {
                const data = conn.outbox.shift()!;
                try {
                    conn.ws.send(toSendable(data));
                } catch {
                    /* socket gone */
                }
            }
            if (conn.closeRequest) {
                try {
                    conn.ws.close(conn.closeRequest.code, conn.closeRequest.reason);
                } catch {
                    /* already closed */
                }
                conn.closeRequest = null;
            }
            if (conn.closed) break;
            await conn.wake;
            armConn(conn);
        }
    }

    private wireSocket(
        conn: Conn,
        handlers: TransportHandlers,
        result: NonNullable<Awaited<ReturnType<TransportHandlers['upgrade']>>>,
    ): void {
        const clientId = result.clientId;
        const reconnecting = result.reconnecting ?? false;
        const tags = result.tags ?? {};
        conn.clientId = clientId;
        conn.tags = tags;

        // if reconnecting, retire the old connection's topic subs.
        const old = this.conns.get(clientId);
        if (old && old !== conn) {
            for (const t of old.topics) this.topics.get(t)?.delete(clientId);
        }
        this.conns.set(clientId, conn);

        const socket: ClientSocket = {
            // never touch the socket directly — route through the owning loop.
            send: (data) => this.enqueueSend(clientId, data as OutboundData),
            close: (code, reason) => this.enqueueClose(clientId, code, reason),
            subscribe: (topic) => {
                conn.topics.add(topic);
                let subs = this.topics.get(topic);
                if (!subs) {
                    subs = new Set();
                    this.topics.set(topic, subs);
                }
                subs.add(clientId);
            },
        };

        if (reconnecting) {
            handlers.reconnect(clientId, socket, result.versionMismatch);
        } else {
            handlers.open(clientId, socket, result.joinData ?? {}, tags, result.versionMismatch);
        }

        conn.ws.addEventListener('message', (e) => {
            // generation guard: ignore frames from a connection that is no longer the
            // current one for this clientId (replaced by a reconnect). mirrors the ws
            // transport — a stale socket must not drive room logic against a live client.
            if (this.conns.get(clientId) !== conn) return;
            const { ab, isBinary } = toArrayBuffer(e.data);
            handlers.message(clientId, ab, isBinary);
        });
        conn.ws.addEventListener('close', (e) => {
            conn.closed = true;
            conn.signal();
            // a stale connection (already replaced in `conns` by a reconnect) self-cleans
            // its own drain loop above but must not touch the new connection's mapping or
            // drive the room-side close — only the current connection owns those.
            if (this.conns.get(clientId) !== conn) return;
            for (const t of conn.topics) this.topics.get(t)?.delete(clientId);
            this.conns.delete(clientId);
            handlers.close(clientId, e.code || 1006);
        });
        conn.ws.addEventListener('error', () => {
            conn.closed = true;
            conn.signal();
            if (this.conns.get(clientId) !== conn) return;
            for (const t of conn.topics) this.topics.get(t)?.delete(clientId);
            this.conns.delete(clientId);
            handlers.close(clientId, 1006);
        });
    }

    // --- send/close routing (memory only — safe from any context) ---

    private enqueueSend(clientId: string, data: OutboundData): void {
        const conn = this.conns.get(clientId);
        if (!conn) return;
        conn.outbox.push(data);
        conn.signal();
    }

    private enqueueClose(clientId: string, code: number, reason: string): void {
        const conn = this.conns.get(clientId);
        if (!conn) return;
        conn.closeRequest = { code, reason };
        conn.signal();
    }

    // --- notify ---

    private enqueueHeartbeat(): void {
        // adapter-synthesized heartbeat: workerd timers don't fire while the isolate
        // is idle, so start()'s own setInterval can't be relied on. report the clients
        // whose sockets are open — the ground truth the server's reconciler expects.
        const clients: { clientId: string; tags: Record<string, string> }[] = [];
        for (const conn of this.conns.values()) {
            if (conn.clientId && !conn.closed) clients.push({ clientId: conn.clientId, tags: conn.tags });
        }
        this.outbox.push({ type: 'heartbeat', timestamp: Date.now(), metrics: undefined, clients });
    }

    private async flush(binding: NotifierBinding): Promise<void> {
        if (this.outbox.length === 0) return;
        const pending = this.outbox;
        this.outbox = [];
        for (const msg of pending) {
            try {
                await binding.notify(JSON.stringify(msg));
            } catch {
                // relay unavailable — drop; the next heartbeat re-establishes liveness.
            }
        }
    }
}

// workerd delivers text frames as string, binary as ArrayBuffer. gatho frames are
// binary (packcat); normalize either into an ArrayBuffer for the engine.
function toArrayBuffer(data: string | ArrayBuffer): { ab: ArrayBuffer; isBinary: boolean } {
    if (typeof data === 'string') {
        return { ab: new TextEncoder().encode(data).buffer as ArrayBuffer, isBinary: false };
    }
    return { ab: data, isBinary: true };
}

function toSendable(data: OutboundData): string | ArrayBuffer | ArrayBufferView {
    return data as string | ArrayBuffer | ArrayBufferView;
}

/**
 * Wrap a room options module as a workerd `ExportedHandler`. The harness loads the
 * bundled result as the room isolate's `mainModule` default export.
 *
 * `def` is the room's default export — a plain `StartOptions` object (the example's
 * own convention; see README). A workerd module can't call top-level `start()`
 * because env/bindings only arrive per-request, so the module exports options and
 * the adapter calls `start()` on the first request.
 */
export function createWorkerdRoom(def: StartOptions<unknown, Record<string, unknown>>): {
    fetch(req: Request, env: RoomEnv, ctx: ExecutionContext): Promise<Response>;
} {
    const room = new WorkerdRoom(def);
    return {
        fetch: (req, env, ctx) => room.fetch(req, env, ctx),
    };
}
