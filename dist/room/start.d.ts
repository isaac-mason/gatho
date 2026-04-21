import type { AuthResult, Client, Room } from './index';
import type { Transport } from './transport/types';
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
     *  when omitted, env vars are checked instead — if `GATHO_SOCKET` is set,
     *  the room connects ipc automatically. mutually exclusive with `standalone`. */
    server?: ServerConfig;
    /** explicit opt-in to run without a managed server context. required when
     *  neither `GATHO_SOCKET`/`GATHO_ROOM_SECRET` env vars are set nor
     *  `options.server.socket`/`options.server.roomSecret` are provided —
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
    onMessage?: (room: Room<NoInfer<ClientData>>, client: Client<NoInfer<ClientData>>, message: string | ArrayBuffer) => void | Promise<void>;
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
export declare function start<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>>(options: StartOptions<ClientData, JoinData>): Promise<Room<ClientData>>;
