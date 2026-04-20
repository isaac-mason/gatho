import type { RoomRunner, SpawnContext, SpawnResult } from './types';

/** spawn context extended with runner helpers. */
export type RunnerSpawnContext = SpawnContext & {
    /** standard gatho environment variables built from this context — ready to spread into a process env or docker -e flags */
    env: Record<string, string>;
    /** call when the room has exited, for any reason (crash, natural exit, killed, etc.) */
    stopped(code: number | null): void;
};

/** destructor returned by the runner spawn function. called by the server to stop the room. */
export type Destructor = () => void | Promise<void>;

/** runner spawn function — receives context, returns a destructor (sync or async). */
export type RunnerSpawnFn = (ctx: RunnerSpawnContext) => Destructor | Promise<Destructor>;

/**
 * ergonomic factory for creating a RoomRunner.
 *
 * the provided function receives a spawn context with a `stopped` callback, sets up the room,
 * and returns a destructor. the destructor is called by the server when it wants the room to stop.
 * `ctx.stopped()` should be called when the room has exited, regardless of the reason.
 *
 * supports both sync and async spawn/destructor — async is useful for runners that need to make
 * API calls (e.g. ECS RunTask, docker create) during setup or teardown.
 *
 * bridges to the internal RoomRunner/SpawnResult interface — the server doesn't need to know
 * about this API.
 */
export function runner(fn: RunnerSpawnFn): RoomRunner {
    return {
        spawn(ctx: SpawnContext): SpawnResult {
            // buffer stopped() calls if they fire before onExit is registered
            let bufferedCode: { code: number | null } | null = null;
            let exitHandler: ((code: number | null) => void) | null = null;
            let delivered = false;

            function deliver(code: number | null): void {
                if (delivered) return;
                delivered = true;
                if (exitHandler) exitHandler(code);
                else bufferedCode = { code };
            }

            // track destructor — may resolve later if spawn is async
            let destructor: Destructor | null = null;
            let queuedKill = false;

            const runnerCtx: RunnerSpawnContext = {
                ...ctx,
                env: {
                    GATHO_ROOM_ID: ctx.roomId,
                    GATHO_SOCKET: ctx.socket,
                    GATHO_ROOM_TYPE: ctx.roomType,
                    GATHO_SERVER_ID: ctx.serverId,
                    GATHO_ROOM_SECRET: ctx.roomSecret,
                },
                stopped: deliver,
            };

            const result = fn(runnerCtx);

            if (result instanceof Promise) {
                result.then((d) => {
                    destructor = d;
                    if (queuedKill) destructor();
                });
            } else {
                destructor = result;
            }

            return {
                kill() {
                    if (destructor) {
                        destructor();
                    } else {
                        queuedKill = true;
                    }
                },
                onExit(handler) {
                    if (bufferedCode !== null) {
                        handler(bufferedCode.code);
                    } else {
                        exitHandler = handler;
                    }
                },
            };
        },
    };
}
