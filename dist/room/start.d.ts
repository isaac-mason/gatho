import type { Notifier } from '../common/notify-protocol';
import type { AuthResult, Client, Room } from './index';
import type { Transport } from './transport/types';
/** server-managed config passed to `create()`. all fields fall back to `GATHO_*` env vars.
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
/** options for building a room via `create()`.
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
 *    useful for local dev and tests. `room.start()` throws if no managed context is
 *    detected and `standalone` is not explicitly set — this prevents accidentally
 *    deploying a room that silently skips auth.
 *
 *  callbacks do NOT receive `room` — capacity checks and messaging use the
 *  `room` handle returned by `create()`, which is in scope in the same block.
 *
 *  generic parameters:
 *  - `ClientData` — the data shape returned by `onAuth` via `{ ok: true, data }`.
 *    inferred from the return type of `onAuth`.
 *  - `JoinData` — the data shape passed to `onAuth`. matches the `data` bag
 *    from `sdk.join({ data })`. annotate the `onAuth` parameter to opt in. */
export type CreateOptions<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>> = {
    /** server-managed config. when provided, fields override `GATHO_*` env vars.
     *  when omitted, env vars are checked instead — if `GATHO_NOTIFY_SOCKET` is
     *  set, the room connects its notify channel automatically. mutually
     *  exclusive with `standalone`. */
    server?: ServerConfig;
    /** explicit opt-in to run without a managed server context. required when
     *  neither `GATHO_NOTIFY_SOCKET`/`GATHO_ROOM_SECRET` env vars are set nor
     *  `options.server.notify`/`options.server.roomSecret` are provided —
     *  otherwise `room.start()` throws. when `true`, all managed config (env vars
     *  and `options.server`) is ignored; a warning is logged if any was present. */
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
     *  return the `AuthResult` union directly as a plain object literal:
     *  `{ ok: true, data }` to accept (data becomes `client.data`),
     *  or `{ ok: false, error }` to reject.
     *  if omitted, all connections are accepted with empty client data.
     *
     *  `joinData` is the arbitrary data bag from `sdk.join({ data })`, or `{}` if omitted.
     *  capacity checks use the closed-over `room` handle (e.g. `room.clients.count()`).
     *  annotate the joinData parameter to get type inference:
     *  ```ts
     *  onAuth: (joinData: { displayName?: string }) =>
     *    ({ ok: true, data: { username: joinData.displayName ?? 'anon' } })
     *  ```
     *
     *  two typescript footguns (both trip ClientData inference):
     *  1. return the literal directly (or annotate the return) — hoisting it
     *     through an untyped local widens `ok` to `boolean` and breaks the union.
     *  2. when referencing the `room` handle, keep it in a STATEMENT (an if-guard
     *     in a block body), not inside the returned expression — an arrow whose
     *     expression body is `room.x ? {ok:false,...} : {ok:true,...}` makes the
     *     return type circular (TS7022). use:
     *     ```ts
     *     onAuth: (join) => {
     *       if (room.clients.count() >= max) return { ok: false, error: 'full' };
     *       return { ok: true, data: { name: join.name } };
     *     }
     *     ``` */
    onAuth?: (joinData: JoinData) => AuthResult<ClientData> | Promise<AuthResult<ClientData>>;
    /** fires after a client is authenticated and added to the room.
     *  this is the room-side view of the same protocol instant as the client's
     *  `onOpen` — both fire on receipt of the `session` message (the client is
     *  authenticated and joined). */
    onJoin?: (client: Client<NoInfer<ClientData>>) => void | Promise<void>;
    /** fires when a connected client sends a websocket message.
     *  text frames arrive as `string`, binary frames as `ArrayBuffer`. */
    onMessage?: (client: Client<NoInfer<ClientData>>, message: string | ArrayBuffer) => void | Promise<void>;
    /** fires when a client permanently leaves the room (consented close,
     *  reconnection window expired, or eviction). */
    onLeave?: (client: Client<NoInfer<ClientData>>) => void | Promise<void>;
    /** fires on non-consented disconnect (close code != 4000).
     *  call `client.allowReconnection(ms)` inside to hold the seat
     *  for the given duration. if you don't call it, the client is evicted
     *  immediately. if `onDrop` is not defined, all disconnects are permanent. */
    onDrop?: (client: Client<NoInfer<ClientData>>, code: number) => void | Promise<void>;
    /** fires when a previously-dropped client reconnects within their
     *  reconnection window. buffered reliable messages are flushed automatically
     *  before this callback runs. */
    onReconnect?: (client: Client<NoInfer<ClientData>>) => void | Promise<void>;
    /** fires on SIGTERM or `room.stop()`. after this returns (or if not provided),
     *  all connections are closed and the room shuts down. */
    onShutdown?: () => void | Promise<void>;
};
/** build a room (synchronous). resolves managed context (env vars / `options.server`),
 *  builds the RoomState and the {@link Room} handle, and stores the lifecycle
 *  callbacks. does NOT open the transport or dial the notify channel — call
 *  `await room.start()` for that.
 *
 *  design: the two-phase split puts everything SYNCHRONOUS here (env reads, the
 *  fail-closed standalone check, identity assignment) so `room.roomId` etc. are
 *  readable immediately and the fail-closed throw is a plain synchronous throw.
 *  the only ASYNC work (notify dial, transport listen, ready signal, heartbeat,
 *  SIGTERM hook) lives in `room.start()`, whose failure mode is a rejected
 *  promise the caller awaits. */
export declare function create<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>>(options: CreateOptions<ClientData, JoinData>): Room<ClientData>;
