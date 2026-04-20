import { spawn } from 'node:child_process';
import type { Destructor, RunnerSpawnContext } from './runner/runner';

const SIGKILL_DELAY_MS = 5_000;

/** options for the `subprocess` helper */
export type SubprocessOptions = {
    /** additional env vars to pass to the subprocess, alongside the standard GATHO_ vars from ctx.env */
    env?: Record<string, string>;
    /** how long to wait after SIGTERM before sending SIGKILL (default 5s) */
    killTimeoutMs?: number;
};

/**
 * spawn-a-child-process helper for use inside a `runner()` callback.
 *
 * the subprocess should call `gatho/room`'s `start()` function (`import { start } from 'gatho/room'`).
 *
 * the process will be started with at least the standard gatho environment variables from `ctx.env`,
 * which `start()` picks up automatically:
 * - `GATHO_ROOM_ID`: the room's unique identifier
 * - `GATHO_SOCKET`: the uds socket path for ipc communication with the server
 * - `GATHO_ROOM_TYPE`: the room type string
 * - `GATHO_SERVER_ID`: the id of the server this room is running on
 * - `GATHO_ROOM_SECRET`: a per-room secret for signing JWTs
 *
 * the caller is responsible for forwarding `ctx.data` (room-specific config) if the subprocess
 * needs it — typically by spreading it into `options.env` with whatever naming/transform you want.
 *
 * wires `child.on('exit', ctx.stopped)` and returns a destructor that sends SIGTERM, escalating
 * to SIGKILL after `killTimeoutMs`.
 *
 * @param ctx the runner spawn context, provided by the enclosing `runner()` callback
 * @param command the full argv array for the subprocess, e.g. `['bun', 'run', 'game-room.ts']`
 * @param options additional env vars and kill timeout
 * @returns a Destructor that terminates the subprocess
 */
export function subprocess(ctx: RunnerSpawnContext, command: string[], options?: SubprocessOptions): Destructor {
    const killTimeout = options?.killTimeoutMs ?? SIGKILL_DELAY_MS;

    const env: Record<string, string | undefined> = {
        ...process.env,
        ...options?.env,
        ...ctx.env,
    };

    const child = spawn(command[0], command.slice(1), {
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    child.on('exit', (code) => ctx.stopped(code));

    let killed = false;

    return () => {
        if (killed) return;
        killed = true;

        child.kill('SIGTERM');

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
        }, killTimeout);
        timer.unref();
    };
}
