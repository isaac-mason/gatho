import { type Notifier } from '../../common/notify-protocol';
import type { SpawnContext } from './types';
/**
 * Build the per-room UDS socket path: `socketDir/<roomId>/sock`.
 *
 * The per-room subdirectory (rather than a flat `socketDir/<roomId>.sock`) is what
 * lets a container runner mount each room only its own socket dir, isolating the
 * notify channel from sibling rooms. `roomId` becomes a path segment, so reject
 * anything that could escape `socketDir`.
 *
 * The socket filename is kept to `sock` (not e.g. `room.sock`) on purpose: unix
 * socket paths have a hard length limit (~104 bytes on macOS) and the per-room
 * subdir already costs the `roomId` segment. `<roomId>/sock` is the same length as
 * the old flat `<roomId>.sock`, so we don't regress paths that used to fit. Don't
 * lengthen this filename without re-checking that limit on the longest socketDir.
 */
export declare function roomSocketPath(socketDir: string, roomId: string): string;
/** options for the `notify.uds` channel helper */
export type UdsNotifyOptions = {
    /** directory for per-room UDS sockets. the socket lives at `socketDir/<roomId>/sock`.
     *  set an explicit path when running rooms in docker (or any other sandbox) so the same
     *  path can be bind-mounted into the room and appear in `GATHO_NOTIFY_SOCKET` unchanged.
     *  defaults to `${os.tmpdir()}/gatho-ipc`. created if it doesn't exist. */
    socketDir?: string;
};
/** a live uds notify channel — the server-side listening end for one room. */
export type UdsNotifyChannel = {
    /** full socket path — pass to the room process (already in `env`) */
    socketPath: string;
    /** this room's own socket directory — `socketPath` lives directly inside it
     *  (`socketDir/<roomId>/sock`). a container runner mounts just this directory into
     *  the room so it can reach its own socket but not any sibling room's. */
    socketDir: string;
    /** env var for the room: GATHO_NOTIFY_SOCKET (`uds:<path>` URI) */
    env: Record<string, string>;
    /** stop listening and remove the socket file. call from the runner's destructor
     *  or once the room has exited. */
    close(): void;
};
/**
 * uds notify channel: creates a unix domain socket at `socketDir/<roomId>/sock`,
 * listens for the room to dial back, and feeds decoded frames to `ctx.onMessage`.
 *
 * resolves once listening — spawn the room after this so `GATHO_NOTIFY_SOCKET`
 * (in `chan.env`) points at a live socket.
 *
 * socket close needs no handling here — a room that hangs up either already sent
 * `stopped` (self-stop) or is about to exit (crash), both of which reach the
 * server through other paths (`stopped` message / runner `ctx.stopped`), with
 * the heartbeat stall sweep as the backstop. a room may redial after a drop.
 */
declare function uds(ctx: SpawnContext, options?: UdsNotifyOptions): Promise<UdsNotifyChannel>;
/** options for the `notify.tcp` channel helper */
export type TcpNotifyOptions = {
    /** host to bind the listener on. default `127.0.0.1` (loopback only). */
    host?: string;
    /** host to advertise in `GATHO_NOTIFY_SOCKET` when the room dials from
     *  somewhere the bind host isn't reachable as-is — e.g. `host.docker.internal`
     *  from inside a container. defaults to the bind host. */
    advertisedHost?: string;
};
/** a live tcp notify channel — the server-side listening end for one room. */
export type TcpNotifyChannel = {
    /** the bound port */
    port: number;
    /** per-room bearer token — already embedded in `env`; exposed for runners
     *  that deliver the uri some other way (e.g. workerd config bindings) */
    token: string;
    /** env var for the room: GATHO_NOTIFY_SOCKET (`tcp://host:port?token=…` URI) */
    env: Record<string, string>;
    /** stop listening and drop the connection */
    close(): void;
};
/**
 * tcp notify channel: loopback listener carrying the same length-prefixed
 * packcat frames as uds. where uds gets isolation from filesystem permissions,
 * tcp gets it from a per-room bearer token: the room must send the token as its
 * first frame or the connection is dropped.
 *
 * for rooms that can't reach a unix socket — containers without a mount,
 * remote-ish sandboxes, workerd isolates (via `connect()`).
 *
 * resolves once listening — spawn the room after this so the uri in `chan.env`
 * points at a live listener.
 */
declare function tcp(ctx: SpawnContext, options?: TcpNotifyOptions): Promise<TcpNotifyChannel>;
/** a live direct (in-memory) notify channel */
export type DirectNotifyChannel = {
    /** hand this to the room's `start()` as `server.notify` — it delivers
     *  straight into the server core, no wire, no serialization */
    notifier: Notifier;
    /** stop delivering (idempotent). the room calling `notifier.close()` has
     *  the same effect. */
    close(): void;
};
/**
 * direct notify channel: no wire at all. for rooms hosted in the same process
 * as the server — the room is handed (a thin gate over) the server core's own
 * notifier. synchronous, unlike the wire channels: there is nothing to bind.
 */
declare function direct(ctx: SpawnContext): DirectNotifyChannel;
/** notify channel helpers, composed inside `runner()` spawn functions. */
export declare const notify: {
    uds: typeof uds;
    tcp: typeof tcp;
    direct: typeof direct;
};
export {};
