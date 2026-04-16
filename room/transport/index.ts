// transport — pluggable ws server backends for room subprocesses.
// the user picks a transport and passes it to startRoom().

export type { Transport as RoomTransport, TransportHandlers, TransportListenConfig, TransportServer, ClientSocket as WsSocket } from './types';
export { type WsTransportConfig, wsTransport } from './ws';
