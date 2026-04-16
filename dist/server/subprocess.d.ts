import type { RoomRunner } from './runner/types';
/** Options for `subprocess` RoomRunner factory */
export type SubprocessOptions = {
    /** additional env vars to pass to the subprocess, alongside the GATHO_ vars */
    env?: Record<string, string>;
    /** how long to wait after SIGTERM before sending SIGKILL (default 5s) */
    killTimeoutMs?: number;
};
/**
 * RoomRunner factory for spawning a subprocess for each room. The subprocess should call `gatho/room`'s `start()` function (`import { start } from 'gatho/room'`)
 *
 * The process will be started with the following environment variables, which `start()` will pick up automatically:
 * - `GATHO_ROOM_ID`: the room's unique identifier
 * - `GATHO_SOCKET`: the uds socket path for ipc communication with the server
 * - `GATHO_ROOM_TYPE`: the room type string
 * - `GATHO_SERVER_ID`: the id of the server this room is running on
 * - `GATHO_ROOM_SECRET`: a per-room secret for signing JWTs
 *
 * @param command the full argv array for the subprocess, e.g. `['bun', 'run', 'game-room.ts']`
 * @param options additional options for environment variables and kill timeout
 * @returns a RoomRunner that spawns a subprocess for each room with the specified command and environment variables
 */
export declare function subprocess(command: string[], options?: SubprocessOptions): RoomRunner;
