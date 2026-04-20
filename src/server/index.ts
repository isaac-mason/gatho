// gatho server public api
// exports start, subprocess helper, runner factory, and types.
// transport internals (uds, ipc) are not exposed — ipc is the only
// communication channel between server and rooms.

export type { RoomRunner, SpawnContext, SpawnResult } from './runner/types';
export { type RunnerSpawnContext, type Destructor, type RunnerSpawnFn, runner } from './runner/runner';
export {
    type CreateServerOptions,
    start,
    type RoomDetails,
    type RoomEndpointFn as EndpointFn,
    type Server,
} from './server';
export { type SubprocessOptions, subprocess } from './subprocess';
