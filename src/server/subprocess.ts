import { spawn } from 'node:child_process';
import { notify, type UdsNotifyOptions } from './runner/notify';
import { type RunnerSpawnContext, runner } from './runner/runner';
import type { RoomRunner } from './runner/types';

const SIGKILL_DELAY_MS = 5_000;

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
export function subprocess(command: string[], options?: SubprocessOptions): RoomRunner {
    const killTimeout = options?.killTimeoutMs ?? SIGKILL_DELAY_MS;

    return runner(async (ctx) => {
        const chan = await notify.uds(ctx, { socketDir: options?.socketDir });
        const userEnv = typeof options?.env === 'function' ? options.env(ctx) : options?.env;

        const env: Record<string, string | undefined> = {
            ...process.env,
            ...userEnv,
            ...ctx.env,
            ...chan.env,
        };

        const child = spawn(command[0], command.slice(1), {
            env: env as NodeJS.ProcessEnv,
            stdio: ['ignore', 'inherit', 'inherit'],
        });

        // single exit path — 'error' (spawn failure) and 'exit' can both fire;
        // report once, then tear the channel down.
        let reported = false;
        function report(code: number | null): void {
            if (reported) return;
            reported = true;
            chan.close();
            ctx.stopped(code);
        }

        child.on('exit', (code) => report(code));
        child.on('error', (err) => {
            ctx.onMessage({ type: 'error', message: `subprocess spawn failed: ${err.message}` });
            report(-1);
        });

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
    });
}
