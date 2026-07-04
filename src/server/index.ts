// gatho server public api
// exports start, the subprocess runner factory, the runner() escape hatch, and
// the notify channel helpers runners compose (notify.uds, ...).
// the server core never owns the notify channel — runners do.

export {
    type DirectNotifyChannel,
    notify,
    roomSocketPath,
    type TcpNotifyChannel,
    type TcpNotifyOptions,
    type UdsNotifyChannel,
    type UdsNotifyOptions,
} from './runner/notify';
export { type Destructor, type RunnerSpawnContext, type RunnerSpawnFn, runner } from './runner/runner';
export type { RoomRunner, SpawnContext, SpawnResult } from './runner/types';
export {
    type CreateServerOptions,
    type RoomDetails,
    type RoomEndpointFn as EndpointFn,
    type Server,
    start,
} from './server';
export { type SubprocessOptions, subprocess } from './subprocess';
