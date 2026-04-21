import type { RoomRunner, SpawnContext } from './types';
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
export declare function runner(fn: RunnerSpawnFn): RoomRunner;
