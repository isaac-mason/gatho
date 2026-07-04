// notify channel helpers — for use inside `runner()` spawn functions.
//
// a channel helper connects a room's Notifier to the server's message handler
// (`ctx.onMessage`) across a process boundary: it listens on some pipe, decodes
// the room's frames, and feeds them to `ctx.onMessage`. helpers resolve once
// they are LISTENING (not once the room connects) so the runner can grab
// `chan.env` before launching the room.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from '../../common/logger';
import { createFrameParser, createFrameReader, type Notifier, notifyCodec } from '../../common/notify-protocol';
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
export function roomSocketPath(socketDir: string, roomId: string): string {
    if (roomId.includes('/') || roomId.includes('\\') || roomId === '.' || roomId === '..') {
        throw new Error(`invalid roomId for socket path: ${JSON.stringify(roomId)}`);
    }
    return join(socketDir, roomId, 'sock');
}

const DEFAULT_SOCKET_DIR = () => join(tmpdir(), 'gatho-ipc');

// --- shared single-connection listener core ---
//
// both wire channels (uds, tcp) hold at most ONE active connection at a time,
// but a room may redial after a drop (e.g. transient network blip on tcp, or a
// room-side reconnect) — so the active slot resets when its socket closes.
// per-channel handlers decide WHEN a socket becomes the active one (uds: on
// connect; tcp: only after the token frame checks out) via `adopt`.
type ListenerCore = {
    server: Server;
    /** idempotent: destroy the active connection and stop listening */
    close(): void;
};

function channelListener(
    label: string,
    roomId: string,
    handleSocket: (socket: Socket, adopt: (socket: Socket) => boolean) => void,
): ListenerCore {
    let active: Socket | null = null;
    let closed = false;

    const server = createServer((socket) => {
        if (closed) {
            socket.destroy();
            return;
        }

        // absorb socket errors — a broken pipe or reset must not become an
        // uncaught EventEmitter error.
        socket.on('error', (err) => {
            log.error(`${label}: socket error`, { roomId, err });
        });
        socket.on('close', () => {
            if (active === socket) active = null;
        });

        handleSocket(socket, (s) => {
            if (active !== null || closed) return false;
            active = s;
            return true;
        });
    });

    return {
        server,
        close() {
            if (closed) return;
            closed = true;
            active?.destroy();
            server.close();
        },
    };
}

// --- uds ---

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
function uds(ctx: SpawnContext, options?: UdsNotifyOptions): Promise<UdsNotifyChannel> {
    const socketDir = options?.socketDir ?? DEFAULT_SOCKET_DIR();
    const socketPath = roomSocketPath(socketDir, ctx.roomId);

    return new Promise((resolve, reject) => {
        const dir = dirname(socketPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // clean up stale socket file if present
        try {
            unlinkSync(socketPath);
        } catch {
            // not there, fine
        }

        const core = channelListener('uds notify', ctx.roomId, (socket, adopt) => {
            if (!adopt(socket)) {
                socket.destroy();
                return;
            }
            const push = createFrameReader(
                (msg) => ctx.onMessage(msg),
                (err) => {
                    log.error('uds notify: malformed frame dropped', { socketPath, err });
                },
            );
            socket.on('data', (chunk: Buffer) => push(chunk));
        });

        function close(): void {
            core.close();
            try {
                unlinkSync(socketPath);
            } catch {
                // already gone
            }
            try {
                rmdirSync(dirname(socketPath));
            } catch {
                // non-empty or already gone — fine
            }
        }

        core.server.on('error', (error) => {
            if (!core.server.listening) {
                reject(error);
                return;
            }
            log.error('uds notify: server error', { socketPath, err: error });
        });

        core.server.listen(socketPath, () => {
            resolve({
                socketPath,
                socketDir: dirname(socketPath),
                env: {
                    GATHO_NOTIFY_SOCKET: `uds:${socketPath}`,
                },
                close,
            });
        });
    });
}

// --- tcp ---

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
function tcp(ctx: SpawnContext, options?: TcpNotifyOptions): Promise<TcpNotifyChannel> {
    const bindHost = options?.host ?? '127.0.0.1';
    const advertisedHost = options?.advertisedHost ?? bindHost;
    const token = randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
        const core = channelListener('tcp notify', ctx.roomId, (socket, adopt) => {
            // token gate: first frame must be the utf-8 token. only a socket that
            // presents it (and wins the active slot) is kept.
            let authed = false;
            const parser = createFrameParser((payload) => {
                if (!authed) {
                    const presented = new TextDecoder().decode(payload);
                    if (presented !== token || !adopt(socket)) {
                        log.warn('tcp notify: rejected connection (bad token or already connected)', {
                            roomId: ctx.roomId,
                        });
                        socket.destroy();
                        return;
                    }
                    authed = true;
                    return;
                }
                try {
                    ctx.onMessage(notifyCodec.unpack(payload));
                } catch (err) {
                    log.error('tcp notify: malformed frame dropped', { roomId: ctx.roomId, err });
                }
            });
            socket.on('data', (chunk: Buffer) => parser(chunk));
        });

        core.server.on('error', (error) => {
            if (!core.server.listening) {
                reject(error);
                return;
            }
            log.error('tcp notify: server error', { roomId: ctx.roomId, err: error });
        });

        core.server.listen(0, bindHost, () => {
            const addr = core.server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('tcp notify: failed to get listener address'));
                return;
            }
            resolve({
                port: addr.port,
                token,
                env: {
                    GATHO_NOTIFY_SOCKET: `tcp://${advertisedHost}:${addr.port}?token=${token}`,
                },
                close: core.close,
            });
        });
    });
}

// --- direct ---

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
function direct(ctx: SpawnContext): DirectNotifyChannel {
    let closed = false;
    return {
        notifier: {
            send(msg) {
                if (!closed) ctx.onMessage(msg);
            },
            close() {
                closed = true;
            },
        },
        close() {
            closed = true;
        },
    };
}

/** notify channel helpers, composed inside `runner()` spawn functions. */
export const notify = {
    uds,
    tcp,
    direct,
};
