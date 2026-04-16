// gatho server public api
// exports createServer, subprocess helper, and types.
// transport internals (uds, ipc) are not exposed — ipc is the only
// communication channel between server and rooms.

export type { RoomRunner, SpawnContext, SpawnResult } from './runner/types';
export {
    type CreateServerOptions,
    createServer,
    type RoomDetails,
    type RoomEndpointFn as EndpointFn,
    type Server,
} from './server';
export { type SubprocessOptions, subprocess } from './subprocess';
