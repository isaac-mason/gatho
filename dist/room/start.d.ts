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
 *    from `sdk.join({ data })`. annotate the `onAuth` parameter to opt in.
 *  - `InMessage` — the expected shape of incoming websocket messages. annotate
 *    the `onMessage` message parameter to opt in. */
export type StartOptions<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>, InMessage = unknown> = {
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
     *  onAuth: (joinData: { displayName?: string }) =>
     *    auth.ok({ username: joinData.displayName ?? 'anon' })
     *  ``` */
    onAuth?: (joinData: JoinData, room: Room<unknown>) => AuthResult<ClientData> | Promise<AuthResult<ClientData>>;
    /** fires after a client is authenticated and added to the room. */
    onJoin?: (room: Room<NoInfer<ClientData>>, client: Client<NoInfer<ClientData>>) => void | Promise<void>;
    /** fires when a connected client sends a websocket message.
     *  annotate the message parameter to get type inference:
     *  ```ts
     *  onMessage: (room, client, message: { text: string }) => { ... }
     *  ``` */
    onMessage?: (room: Room<NoInfer<ClientData>>, client: Client<NoInfer<ClientData>>, message: InMessage) => void | Promise<void>;
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
export declare function start<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>, InMessage = unknown>(options: StartOptions<ClientData, JoinData, InMessage>): Promise<Room<ClientData>>;
