import type { RoomData } from '../../driver/types';

/**
 * Context passed to RoomRunner.spawn() when creating a room process.
 *
 * Contains room identity, server identity, per-room secret, arbitrary data from createRoom options,
 * and the UDS socket path for IPC communication with the server.
 *
 * The spawn function can forward this data to the room process via environment variables,
 * command line arguments, config files, or any other method it chooses.
 */
export type SpawnContext = {
    /** the room's unique identifier */
    roomId: string;

    /** the room type string, from createRoom options */
    roomType: string;

    /** the id of the server this room is running on, or undefined if not using multiple servers */
    serverId: string;

    /** a per-room secret for signing JWTs, exposed as GATHO_ROOM_SECRET env var in the room process */
    roomSecret: string;

    /** arbitrary data from createRoom options, for the spawn function to forward to the room process however it wants (env vars, args, config file, etc.) */
    data: RoomData;

    /** full UDS socket path — the spawn function passes this to the room process */
    socket: string;
};

/** Handle returned by RoomRunner.spawn() for managing the room process. */
export type SpawnResult = {
    kill(): void;
    onExit(handler: (code: number | null) => void): void;
};

/** Interface for spawning and managing room processes. */
export type RoomRunner = {
    spawn(ctx: SpawnContext): SpawnResult;
};
