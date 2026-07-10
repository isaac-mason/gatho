// gatho/room — room-side api
// rooms are scripts. user calls create() to build a Room handle (sync), then
// awaits room.start() to bring it online. no defineRoom, no hook bags, no
// RoomContext. the module IS the room: state closes over module scope, and
// instancing happens by evaluating the module in a fresh process / worker /
// isolate.

export type {
    Notifier,
    NotifyMessage,
} from '../common/notify-protocol';
// protocol helpers for non-node runtimes that need to speak the notify wire
// protocol themselves (e.g. a workerd harness relaying room notifications over tcp)
export { createFrameParser, encodeNotifyFrame, encodeRawFrame, notifyCodec } from '../common/notify-protocol';
export type { CreateOptions, ServerConfig } from './start';
export { create } from './start';
export type { WsTransportConfig } from './transport/index';
export { wsTransport } from './transport/index';
export type {
    ClientSocket,
    Transport,
    TransportHandlers,
    TransportListenConfig,
    TransportServer,
} from './transport/types';

// --- close codes ---

// re-exported from common/ so the client can share the constant without
// importing gatho/room. see src/common/close-code.ts.
export { CloseCode } from '../common/close-code';

// --- auth result ---

// discriminated union for onAuth return
// ok: true — client accepted, data becomes client.data
// ok: false — client rejected, error is sent to client before close
export type AuthResult<ClientData> = { ok: true; data: ClientData } | { ok: false; error: unknown };

// helpers for returning auth results with correct literal types
// avoids the user needing `as const` on every return
export const auth = {
    ok<T = Record<string, never>>(data: T = {} as T): AuthResult<T> {
        return { ok: true, data };
    },
    fail(error: unknown): { ok: false; error: unknown } {
        return { ok: false, error };
    },
};

// --- client ---

// options for client.send()
//
// reliable (default true): ordered, delivered, and buffered across a
// reconnection window — the message survives a drop and is flushed on reconnect.
//
// reliable: false — best-effort. the message MAY be dropped and MAY be
// reordered; it is never buffered or retransmitted, and it drops outright if the
// client is disconnected. keep unreliable payloads small (~1KB). on today's ws
// transport an unreliable message happens to arrive ordered and intact while the
// socket stays connected, but that is a property of ws, NOT a promise of this
// contract — do not rely on it. there is no ordering guarantee BETWEEN the
// reliable and unreliable channels. webtransport datagrams will map onto this
// same unreliable contract later.
export type SendOptions = { reliable?: boolean };

// client handle within a room — carries identity, data, and per-client verbs.
//
// STABLE IDENTITY: one Client object is cached per tracked client for its whole
// lifetime — the same reference is passed to every callback (onJoin, onMessage,
// onDrop, onReconnect, onLeave) and returned from room.clients iteration/get.
// this makes `Map<Client, T>` keys and `===` identity checks reliable.
//
// STALE HANDLES: after a client permanently leaves (onLeave / eviction) its
// handle is dead. verbs on a dead handle (send, allowReconnection, disconnect)
// are silent no-ops. `bufferedAmount` reads 0. this matches the pre-reshape
// behavior of room.send with a stale client.
export type Client<ClientData = Record<string, unknown>> = {
    // unique client identifier
    readonly id: string;
    // client-specific data populated from onAuth return value
    readonly data: ClientData;

    // send a message to this client.
    // if the client is connected, sends immediately; if disconnected within a
    // reconnection window, a reliable message (default) is buffered and flushed
    // on reconnect. unreliable messages drop while disconnected. no-op on a
    // stale handle.
    send(message: string | ArrayBuffer | ArrayBufferView, options?: SendOptions): void;

    // reconnection — call from onDrop to hold this client's seat for windowMs.
    // if not called, the client is evicted immediately on disconnect. no-op on
    // a stale handle or while the client is connected.
    allowReconnection(windowMs: number): void;

    // server-initiated disconnect. closes with code 4000 (CONSENTED) — onDrop
    // does NOT fire, straight to onLeave. no-op on a stale handle.
    disconnect(): void;

    // outbound socket buffer depth in bytes — the live socket's bufferedAmount,
    // 0 when the client is disconnected or the transport can't report it. this
    // is the backpressure pacing signal for large-payload streaming (chunk a big
    // snapshot, check this between chunks, defer while it's high). gatho ships NO
    // automatic backpressure policy — the pacing/eviction decision is yours.
    readonly bufferedAmount: number;
};

// client collection interface
export type ClientCollection<ClientData> = {
    get(id: string): Client<ClientData> | undefined;
    has(id: string): boolean;
    count(): number;
    forEach(callback: (client: Client<ClientData>, id: string) => void): void;
    ids(): string[];
    all(): Client<ClientData>[];
    // iterate client handles directly — `for (const c of room.clients)` — without
    // allocating an intermediate array (unlike `all()`). yields one handle per client.
    [Symbol.iterator](): IterableIterator<Client<ClientData>>;
};

// --- room handle ---

// options for room.broadcast()
export type BroadcastOptions<ClientData = Record<string, unknown>> = {
    // same reliable/unreliable contract as SendOptions: reliable (default) is
    // ordered, delivered, and buffered across reconnects; reliable: false is
    // best-effort (may drop, may reorder, never buffered, keep it small ~1KB).
    reliable?: boolean;
    // clients to exclude from this broadcast. the classic "echo to everyone but the
    // sender" case. excluded clients receive nothing — not even a buffered copy for
    // reconnect delivery. setting this abandons the pub/sub fast path for a per-socket
    // send that skips the excluded ids.
    except?: Client<ClientData> | Client<ClientData>[];
};

// the Room handle — built synchronously by create(), brought online by start().
//
// per-client verbs (send / allowReconnection / disconnect / bufferedAmount) live
// on the Client handle, not here — there is one way to do each.
//
// PRE-START: broadcast() before start() throws (always a programming error).
// clients is safe to read before start() (it is empty — no connections exist
// until start() opens the transport). POST-STOP: broadcast() is a silent no-op.
export type Room<ClientData = Record<string, unknown>> = {
    // identity
    readonly roomId: string;
    readonly roomType: string;
    readonly serverId: string | undefined;

    // messaging
    broadcast(message: string | ArrayBuffer | ArrayBufferView, options?: BroadcastOptions<ClientData>): void;

    // clients
    readonly clients: ClientCollection<ClientData>;

    // lifecycle — bring the room online (dial notify, listen, signal ready, start
    // heartbeats). async; idempotent-guarded (a second call throws).
    start(): Promise<void>;
    stop(): Promise<void>;
};
