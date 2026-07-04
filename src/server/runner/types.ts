import type { NotifyMessage } from '../../common/notify-protocol';
import type { RoomData } from '../../driver/types';

/**
 * Context passed to RoomRunner.spawn() when creating a room.
 *
 * Contains room identity, server identity, per-room secret, arbitrary data from
 * createRoom options, and two injected sinks pointing back at the server core:
 * `notifier` and `stopped`.
 *
 * The runner executes inside the gatho server process — the context and its
 * functions never cross a process boundary. The room, on the other side of
 * whatever channel the runner establishes, only ever sees its own room-side
 * Notifier; its messages travel as bytes and the channel pipes them into
 * `ctx.onMessage` here.
 */
export type SpawnContext = {
    /** the room's unique identifier */
    roomId: string;

    /** the room type string, from createRoom options */
    roomType: string;

    /** the id of the server this room is running on */
    serverId: string;

    /** a per-room secret for signing JWTs, exposed as GATHO_ROOM_SECRET env var in the room */
    roomSecret: string;

    /** arbitrary data from createRoom options, for the spawn function to forward to the room however it wants (env vars, args, config file, etc.) */
    data: RoomData;

    /**
     * the server's notify-message handler for this room, handed to the runner as
     * a callback. calling it means "treat this as a message the room sent" —
     * notify channel helpers pipe their decoded frames into it; runners call it
     * directly only to synthesize messages on the room's behalf (e.g. surfacing
     * a spawn failure as `{ type: 'error' }`). fire-and-forget, ordered, bound
     * to this room; ignored after `stopped()`.
     */
    onMessage(msg: NotifyMessage): void;

    /**
     * call when the room has exited, for any reason (crash, natural exit, killed,
     * etc.). this is the runner's own observation — deliberately NOT a notify
     * message, so a room can never forge its own exit over the wire. idempotent:
     * extra calls are ignored.
     */
    stopped(code: number | null): void;

    /**
     * the room's lifecycle as observed by the server core: `starting` until the
     * room's `ready` notify message, `ready` after it, `stopped` once the room
     * has exited or self-stopped. lets a runner make decisions the room can't
     * report itself — e.g. a docker runner surfacing a nonzero exit while still
     * `starting` as a startup failure, without tapping the message stream.
     */
    status(): 'starting' | 'ready' | 'stopped';
};

/** Handle returned by RoomRunner.spawn() for stopping the room. */
export type SpawnResult = {
    kill(): void;
};

/** Interface for spawning and managing rooms. Use the `runner()` factory to build one. */
export type RoomRunner = {
    spawn(ctx: SpawnContext): SpawnResult;
};
