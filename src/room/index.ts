// gatho/room — room-side api
// rooms are scripts. user initializes state in module scope, calls start()
// which returns a Room handle. no defineRoom, no hook bags, no RoomContext.
// the module IS the room: state closes over module scope, and instancing
// happens by evaluating the module in a fresh process / worker / isolate.

export type {
    Notifier,
    NotifyMessage,
} from '../common/notify-protocol';
// protocol helpers for non-node runtimes that need to speak the notify wire
// protocol themselves (e.g. a workerd harness relaying room notifications over tcp)
export { createFrameParser, encodeNotifyFrame, encodeRawFrame, notifyCodec } from '../common/notify-protocol';
export type { ServerConfig, StartOptions } from './start';
export { start } from './start';
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

// websocket close codes that gatho uses to distinguish disconnect reasons.
// 4000 (CONSENTED) = the client explicitly called close() — sent __leave first.
// everything else fires onDrop, giving the room code a chance to call allowReconnection.
export const CloseCode = {
    NORMAL: 1000,
    GOING_AWAY: 1001,
    ABNORMAL: 1006,
    CONSENTED: 4000,
} as const;

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

// client representation within a room — plain data, no methods
export type Client<ClientData = Record<string, unknown>> = {
    // unique client identifier
    id: string;
    // client-specific data populated from onAuth return value
    data: ClientData;
};

// client collection interface
export type ClientCollection<ClientData> = {
    get(id: string): Client<ClientData> | undefined;
    has(id: string): boolean;
    count(): number;
    forEach(callback: (client: Client<ClientData>, id: string) => void): void;
    ids(): string[];
    all(): Client<ClientData>[];
};

// --- room handle ---

// options for room.send() and room.broadcast()
export type SendOptions = { reliable?: boolean };

// the Room handle — returned by start(), also passed as first arg to all callbacks
export type Room<ClientData = Record<string, unknown>> = {
    // identity
    readonly roomId: string;
    readonly roomType: string;
    readonly serverId: string | undefined;

    // messaging
    send(client: Client<ClientData>, message: string | ArrayBuffer | ArrayBufferView, options?: SendOptions): void;
    broadcast(message: string | ArrayBuffer | ArrayBufferView, options?: SendOptions): void;

    // clients
    readonly clients: ClientCollection<ClientData>;

    // reconnection — call from onDrop to hold a client's seat for windowMs.
    // if not called, the client is evicted immediately on disconnect.
    allowReconnection(client: Client<ClientData>, windowMs: number): void;

    // server-initiated disconnect. closes with code 4000 (CONSENTED) —
    // onDrop does NOT fire, straight to onLeave.
    disconnect(client: Client<ClientData>): void;

    // lifecycle
    stop(): Promise<void>;
};
