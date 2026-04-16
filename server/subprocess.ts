import { spawn } from 'node:child_process';
import type { RoomRunner, SpawnContext, SpawnResult } from './runner/types';

const SIGKILL_DELAY_MS = 5_000;

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
export function subprocess(command: string[], options?: SubprocessOptions): RoomRunner {
    return {
        spawn(ctx: SpawnContext): SpawnResult {
            const killTimeout = options?.killTimeoutMs ?? SIGKILL_DELAY_MS;

            const child = spawn(command[0], command.slice(1), {
                env: {
                    ...process.env,
                    ...options?.env,
                    GATHO_ROOM_ID: ctx.roomId,
                    GATHO_SOCKET: ctx.socket,
                    GATHO_ROOM_TYPE: ctx.roomType,
                    GATHO_SERVER_ID: ctx.serverId,
                    GATHO_ROOM_SECRET: ctx.roomSecret,
                },
                stdio: ['ignore', 'inherit', 'inherit'],
            });

            let killed = false;
            let escalationTimer: ReturnType<typeof setTimeout> | null = null;

            child.on('exit', () => {
                killed = true;
                if (escalationTimer) {
                    clearTimeout(escalationTimer);
                    escalationTimer = null;
                }
            });

            return {
                kill() {
                    if (killed) return;

                    // SIGTERM — let the process handle it gracefully
                    child.kill('SIGTERM');

                    // escalate to SIGKILL if it doesn't exit in time
                    escalationTimer = setTimeout(() => {
                        if (!killed) {
                            child.kill('SIGKILL');
                        }
                    }, killTimeout);
                    escalationTimer.unref();
                },
                onExit(handler) {
                    child.on('exit', (code) => handler(code));
                },
            };
        },
    };
}
