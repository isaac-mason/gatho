import { type UdsNotifyOptions } from './runner/notify';
import { type RunnerSpawnContext } from './runner/runner';
import type { RoomRunner } from './runner/types';
/** options for the `subprocess` runner factory */
export type SubprocessOptions = UdsNotifyOptions & {
    /** additional env vars to pass to the subprocess, alongside the standard GATHO_ vars.
     *  pass a function to derive per-room env from the spawn context — this is how
     *  room-specific config (`ctx.data`, from createRoom options) reaches the process:
     *  `subprocess(cmd, { env: (ctx) => ({ GAMEMODE: String(ctx.data.gamemode) }) })` */
    env?: Record<string, string> | ((ctx: RunnerSpawnContext) => Record<string, string>);
    /** how long to wait after SIGTERM before sending SIGKILL (default 5s) */
    killTimeoutMs?: number;
};
/**
 * spawn-a-child-process room runner.
 *
 * the subprocess should build its room with `gatho/room`'s `create()` and call
 * `await room.start()` (`import { create } from 'gatho/room'`).
 *
 * establishes a uds notify channel, then starts the process with at least the standard
 * gatho environment variables, which `create()` picks up automatically:
 * - `GATHO_ROOM_ID`: the room's unique identifier
 * - `GATHO_ROOM_TYPE`: the room type string
 * - `GATHO_SERVER_ID`: the id of the server this room is running on
 * - `GATHO_ROOM_SECRET`: a per-room secret for signing JWTs
 * - `GATHO_NOTIFY_SOCKET`: where to dial the notify channel
 *
 * room-specific config (`ctx.data` in a custom `runner()`) is not forwarded automatically —
 * use `options.env` (or a custom runner) to pass it with whatever naming/transform you want.
 *
 * a spawn failure (e.g. missing binary) is surfaced as a synthesized `error` notify message
 * so it's visible in gatho's own reporting, not just the host's stderr.
 *
 * @param command the full argv array for the subprocess, e.g. `['bun', 'run', 'game-room.ts']`
 * @param options additional env vars, kill timeout, socket dir
 */
export declare function subprocess(command: string[], options?: SubprocessOptions): RoomRunner;
