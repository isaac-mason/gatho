// gatho workerd harness (example code — public API only)
//
// One static worker, generated once per gatho server (not per room). It owns:
//
//  - the CLIENT socket (default export): path-routes `/:roomId/*` websocket
//    upgrades and requests into the matching room isolate.
//  - the ADMIN socket (Admin entrypoint, loopback + bearer token): the host
//    runner's admission API. POST /rooms/:id registers a room (config + notify
//    link) and warms its isolate; DELETE unregisters it; POST /__gatho/tick wakes
//    every resident isolate so its due timers run and it re-emits a heartbeat.
//  - the NotifierRelay entrypoint (loopback service binding handed to each room):
//    receives the room's notify messages and relays them over that room's single
//    long-lived TCP connection to the gatho server's notify listener.
//
// Two workerd constraints shape this design:
//   1. A `WorkerStub` (from `env.LOADER.get`) is request-context-bound — it can't
//      be stashed in module scope and reused from another request. So we store the
//      room's *config* and re-`get()` a context-local stub in every request (the
//      loader cache guarantees the same isolate; the factory runs only on load).
//   2. I/O can't cross request contexts. The room's TCP socket is therefore owned
//      by the admission request (kept alive for the room's lifetime via
//      `waitUntil`); notify RPCs from other contexts only push JSON onto an
//      in-memory queue that the admission-context relay loop drains.
//
// We relay newline-delimited JSON rather than gatho's packcat notify frames: the
// isolate can't produce packcat frames without `allow_eval_during_startup`, and
// keeping the relay codec-free means the harness needs no eval permission at all.

import { connect } from 'cloudflare:sockets';
import { WorkerEntrypoint } from 'cloudflare:workers';

// --- workerd binding types (declared loosely to avoid a workers-types dep) ---

type WorkerStub = {
    getEntrypoint(name?: string, opts?: { props?: Record<string, unknown> }): { fetch(req: Request): Promise<Response> };
};
type WorkerCode = {
    compatibilityDate: string;
    compatibilityFlags?: string[];
    mainModule: string;
    modules: Record<string, string>;
    env?: Record<string, unknown>;
    globalOutbound?: unknown;
};
type WorkerLoader = { get(id: string, factory: () => WorkerCode): WorkerStub };
type CtxExports = { NotifierRelay(opts: { props: Record<string, unknown> }): unknown };
type ExecCtx = { waitUntil(p: Promise<unknown>): void; exports: CtxExports };
type HarnessEnv = { LOADER: WorkerLoader; ADMIN_TOKEN: string };

type RoomConfig = {
    bundleJs: string;
    roomType: string;
    roomSecret: string;
    serverId: string;
    clientPort: number;
};

// --- per-room state (module scope — shared across all entrypoints of this isolate) ---

type RoomEntry = {
    config: RoomConfig;
    queue: string[];
    closed: boolean;
    wake: Promise<void>;
    signal: () => void;
};

const rooms = new Map<string, RoomEntry>();

function arm(entry: RoomEntry): void {
    entry.wake = new Promise<void>((res) => {
        entry.signal = res;
    });
}

// build the WorkerCode for a room, binding a per-room NotifierRelay from the
// CURRENT request's ctx.exports. Called inside `loader.get()` — only actually runs
// on a cache miss (first load / reload).
function workerCodeFor(roomId: string, config: RoomConfig, ctxExports: CtxExports): WorkerCode {
    return {
        compatibilityDate: '2025-05-01',
        // `allow_eval_during_startup` is load-bearing: gatho's room engine frames
        // its client protocol with packcat, which builds serializers via
        // `new Function(...)` at module init. workerd forbids code generation by
        // default; this flag permits it during startup only (the built codecs run
        // fine at request time). See the README "Findings" section.
        compatibilityFlags: ['nodejs_compat', 'allow_eval_during_startup'],
        mainModule: 'room.js',
        modules: { 'room.js': config.bundleJs },
        env: {
            GATHO_ROOM_ID: roomId,
            GATHO_ROOM_TYPE: config.roomType,
            GATHO_ROOM_SECRET: config.roomSecret,
            GATHO_SERVER_ID: config.serverId,
            GATHO_CLIENT_PORT: String(config.clientPort),
            NOTIFIER: ctxExports.NotifierRelay({ props: { roomId } }),
        },
        globalOutbound: null,
    };
}

function stubFor(loader: WorkerLoader, ctxExports: CtxExports, roomId: string): WorkerStub | null {
    const entry = rooms.get(roomId);
    if (!entry) return null;
    return loader.get(roomId, () => workerCodeFor(roomId, entry.config, ctxExports));
}

// --- notify relay loop: owns the room's TCP socket, drains its queue ---

async function relayLoop(entry: RoomEntry, host: string, port: number, token: string): Promise<void> {
    const socket = connect({ hostname: host, port });
    const writer = socket.writable.getWriter();
    const enc = new TextEncoder();
    try {
        // line 0 is the auth token; each subsequent line is one JSON notify message.
        await writer.write(enc.encode(`${token}\n`));
        while (true) {
            while (entry.queue.length > 0) {
                const json = entry.queue.shift()!;
                await writer.write(enc.encode(`${json}\n`));
            }
            if (entry.closed) break;
            await entry.wake;
            arm(entry);
        }
    } catch {
        // TCP error — the gatho server's heartbeat-stall sweep reschedules the room.
    } finally {
        try {
            await writer.close();
        } catch {
            /* already gone */
        }
        try {
            (socket as { close?: () => void }).close?.();
        } catch {
            /* ignore */
        }
    }
}

// --- CLIENT socket: route ws upgrades / requests into the room isolate ---

export default {
    async fetch(req: Request, env: HarnessEnv, ctx: ExecCtx): Promise<Response> {
        const url = new URL(req.url);
        const parts = url.pathname.split('/').filter(Boolean);
        const roomId = parts[0];
        if (!roomId) return new Response('missing roomId in path', { status: 404 });

        const stub = stubFor(env.LOADER, ctx.exports, roomId);
        if (!stub) return new Response(`no such room: ${roomId}`, { status: 404 });

        // strip the roomId segment; forward the rest + query to the room isolate.
        const rest = parts.slice(1).join('/');
        const forwardReq = new Request(`https://room/${rest}${url.search}`, req);
        return stub.getEntrypoint().fetch(forwardReq);
    },
};

// --- ADMIN socket: admission API for the host runner ---

export class Admin extends WorkerEntrypoint<HarnessEnv> {
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const ctx = this.ctx as unknown as ExecCtx;

        // bearer-token gate (loopback socket, but defence in depth).
        const auth = req.headers.get('authorization') ?? '';
        if (this.env.ADMIN_TOKEN && auth !== `Bearer ${this.env.ADMIN_TOKEN}`) {
            return new Response('unauthorized', { status: 401 });
        }

        // POST /__gatho/tick — wake every resident isolate.
        if (req.method === 'POST' && url.pathname === '/__gatho/tick') {
            for (const roomId of rooms.keys()) {
                const stub = stubFor(this.env.LOADER, ctx.exports, roomId);
                if (!stub) continue;
                ctx.waitUntil(
                    stub
                        .getEntrypoint()
                        .fetch(new Request('https://room/__gatho/tick', { method: 'GET' }))
                        .then(() => undefined)
                        .catch(() => undefined),
                );
            }
            return new Response('ticked', { status: 200 });
        }

        const m = url.pathname.match(/^\/rooms\/([^/]+)$/);
        if (!m) return new Response('not found', { status: 404 });
        const roomId = decodeURIComponent(m[1]);

        if (req.method === 'POST') return this.admit(roomId, req, ctx);
        if (req.method === 'DELETE') {
            const entry = rooms.get(roomId);
            if (entry) {
                entry.closed = true;
                entry.signal();
                rooms.delete(roomId);
            }
            return new Response('deleted', { status: 200 });
        }
        return new Response('method not allowed', { status: 405 });
    }

    private async admit(roomId: string, req: Request, ctx: ExecCtx): Promise<Response> {
        const body = (await req.json()) as RoomConfig & { notifyUri: string };
        const notify = new URL(body.notifyUri); // tcp://host:port?token=...
        const token = notify.searchParams.get('token') ?? '';

        const entry: RoomEntry = {
            config: {
                bundleJs: body.bundleJs,
                roomType: body.roomType,
                roomSecret: body.roomSecret,
                serverId: body.serverId,
                clientPort: body.clientPort,
            },
            queue: [],
            closed: false,
            wake: Promise.resolve(),
            signal: () => {},
        };
        arm(entry);
        rooms.set(roomId, entry);

        // The relay loop lives for the room's lifetime, owning its TCP socket AND —
        // crucially — keeping THIS admission request context alive. The room's
        // isolate is warmed here so its `env.NOTIFIER` binds to this long-lived
        // context; notify calls from the room then stay valid.
        ctx.waitUntil(relayLoop(entry, notify.hostname, Number(notify.port), token));

        const stub = stubFor(this.env.LOADER, ctx.exports, roomId);
        if (stub) {
            // warm the isolate: starts the engine and emits `ready` promptly.
            ctx.waitUntil(
                stub
                    .getEntrypoint()
                    .fetch(new Request('https://room/__gatho/tick', { method: 'GET' }))
                    .then(() => undefined)
                    .catch(() => undefined),
            );
        }

        return new Response('admitted', { status: 200 });
    }
}

// --- NotifierRelay: loopback target for each room's notifications ---

export class NotifierRelay extends WorkerEntrypoint<HarnessEnv> {
    // called by the room isolate as `env.NOTIFIER.notify(json)`.
    notify(json: string): void {
        const props = (this.ctx as { props?: { roomId?: string } }).props;
        const roomId = props?.roomId;
        if (!roomId) return;
        const entry = rooms.get(roomId);
        if (!entry || entry.closed) return;
        entry.queue.push(json);
        entry.signal();
    }
}
