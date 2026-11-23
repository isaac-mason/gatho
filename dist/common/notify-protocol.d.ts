export type ProcessMetricsMessage = {
    memoryRss: number;
    memoryHeapUsed: number;
    memoryHeapTotal: number;
    cpuUser: number;
    cpuSystem: number;
};
export type ReadyMessage = {
    type: 'ready';
    /** uint16 */
    port: number;
};
export type HeartbeatMessage = {
    type: 'heartbeat';
    timestamp: number;
    metrics: ProcessMetricsMessage | undefined;
    clients: {
        clientId: string;
        tags: Record<string, string>;
    }[];
};
export type ClientConnectedMessage = {
    type: 'client-connected';
    clientId: string;
    roomId: string;
    tags: Record<string, string>;
};
export type ClientDisconnectedMessage = {
    type: 'client-disconnected';
    clientId: string;
};
export type ErrorMessage = {
    type: 'error';
    message: string;
};
export type StoppedMessage = {
    type: 'stopped';
};
export type NotifyMessage = ReadyMessage | HeartbeatMessage | ClientConnectedMessage | ClientDisconnectedMessage | ErrorMessage | StoppedMessage;
/** encoder and decoder for the notify payload (no length framing) */
export declare const notifyCodec: {
    pack(msg: NotifyMessage): Uint8Array<ArrayBuffer>;
    /** decode one payload. throws an Error on anything malformed. */
    unpack(payload: Uint8Array): NotifyMessage;
};
/** the room's handle for notifying its managing server — connected over
 *  uds/tcp, or wired straight to the server's message handler when hosted
 *  in-process (`notify.direct`). */
export type Notifier = {
    send: (msg: NotifyMessage) => void;
    close: () => void;
};
/** wrap raw payload bytes in a length-prefixed frame */
export declare function encodeRawFrame(payload: Uint8Array): Uint8Array;
/** encode a notify message as a length-prefixed frame, ready to write to any pipe */
export declare function encodeNotifyFrame(msg: NotifyMessage): Uint8Array;
/** streaming frame parser — handles partial reads and buffering across chunks.
 *  returns a push function that accepts raw chunks and invokes `onFrame` with
 *  each complete payload (header stripped). */
export declare function createFrameParser(onFrame: (payload: Uint8Array) => void): (data: Uint8Array) => void;
/** streaming notify-message reader built on the frame parser.
 *  malformed frames are dropped via `onError` rather than thrown — callers are
 *  socket 'data' handlers which must not throw. */
export declare function createFrameReader(onMessage: (msg: NotifyMessage) => void, onError?: (err: unknown) => void): (data: Uint8Array) => void;
