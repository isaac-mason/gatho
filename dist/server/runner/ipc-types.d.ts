export type ReadyMessage = {
    type: 'ready';
    /** the port number for the room server */
    port: number;
};
export type ProcessMetricsMessage = {
    /** resident set size in bytes */
    memoryRss: number;
    /** heap used in bytes */
    memoryHeapUsed: number;
    /** heap total in bytes */
    memoryHeapTotal: number;
    /** cumulative user cpu time in microseconds */
    cpuUser: number;
    /** cumulative system cpu time in microseconds */
    cpuSystem: number;
};
export type HeartbeatMessage = {
    type: 'heartbeat';
    /** timestamp of the heartbeat */
    timestamp: number;
    /** process resource metrics */
    metrics: ProcessMetricsMessage;
    /** ids of clients currently connected to this room */
    clientIds: string[];
};
export type ClientConnectedMessage = {
    type: 'client-connected';
    /** id of the client that connected */
    clientId: string;
};
export type ClientDisconnectedMessage = {
    type: 'client-disconnected';
    /** id of the client that disconnected */
    clientId: string;
};
export type ErrorMessage = {
    type: 'error';
    /** error message */
    message: string;
};
export type StoppedMessage = {
    type: 'stopped';
};
export type RoomMessage = ReadyMessage | HeartbeatMessage | ClientConnectedMessage | ClientDisconnectedMessage | ErrorMessage | StoppedMessage;
