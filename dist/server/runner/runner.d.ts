import type { RoomRunner, SpawnContext } from './types';
/** spawn context extended with runner helpers. */
export type RunnerSpawnContext = SpawnContext & {
    /** standard gatho environment variables built from this context — ready to spread into a
     *  process env or docker -e flags. note: the notify channel's own env (GATHO_NOTIFY_SOCKET)
     *  comes from the channel helper (e.g. `notify.uds(ctx)`), not from here. */
    env: Record<string, string>;
};
/** destructor returned by the runner spawn function. called by the server to stop the room. */
export type Destructor = () => void | Promise<void>;
/** runner spawn function — receives context, returns a destructor (sync or async). */
export type RunnerSpawnFn = (ctx: RunnerSpawnContext) => Destructor | Promise<Destructor>;
/**
 * ergonomic factory for creating a RoomRunner.
 *
 * the provided function receives a spawn context carrying two sinks into the server core —
 * `ctx.onMessage` (room→server notify messages) and `ctx.stopped` (the room exited) — sets up
 * the room, and returns a destructor. the destructor is called by the server when it wants the
 * room to stop. `ctx.stopped()` should be called when the room has exited, for any reason.
 *
 * how notify messages get from the room into `ctx.onMessage` is this function's business:
 * compose a channel helper (`notify.uds(ctx)`, `notify.tcp(ctx)`, `notify.direct(ctx)`) or
 * send on it directly to synthesize messages on the room's behalf.
 *
 * supports both sync and async spawn/destructor — async is useful for runners that need to make
 * API calls (e.g. ECS RunTask, docker create) during setup or teardown. if an async spawn
 * rejects, the failure is surfaced as a synthesized `{ type: 'error' }` notify message followed
 * by `stopped(null)`.
 */
export declare function runner(fn: RunnerSpawnFn): RoomRunner;
