// notify protocol — the room→server notification schema and framing.
//
// messages flow one direction: room → server. the server never speaks back on
// this channel (stop is delivered out-of-band by the runner's destructor).
//
// this module is runtime-neutral on purpose: no Buffer, no node imports. the
// uds and tcp channels both carry these frames; the direct (in-memory) channel
// skips framing and passes messages by reference; non-node runtimes (workerd,
// deno, bun) can use the codec + frame helpers to speak the same protocol.
//
// frame format: length(4 bytes, uint32 BE) + payload(length bytes).
// notify frames carry a packcat-encoded NotifyMessage payload. the tcp channel
// additionally sends one raw frame first: the utf-8 auth token.

import * as pack from 'packcat';

// --- message schema ---

const ProcessMetrics = pack.object({
    memoryRss: pack.float64(),
    memoryHeapUsed: pack.float64(),
    memoryHeapTotal: pack.float64(),
    cpuUser: pack.float64(),
    cpuSystem: pack.float64(),
});

const Ready = pack.object({
    type: pack.literal('ready'),
    port: pack.uint16(),
});

const HeartbeatClient = pack.object({
    clientId: pack.string(),
    tags: pack.record(pack.string()),
});

const Heartbeat = pack.object({
    type: pack.literal('heartbeat'),
    timestamp: pack.float64(),
    // optional: not every room runtime can report process metrics (e.g. a
    // workerd isolate has no process.memoryUsage)
    metrics: pack.optional(ProcessMetrics),
    clients: pack.list(HeartbeatClient),
});

const ClientConnected = pack.object({
    type: pack.literal('client-connected'),
    clientId: pack.string(),
    roomId: pack.string(),
    tags: pack.record(pack.string()),
});

const ClientDisconnected = pack.object({
    type: pack.literal('client-disconnected'),
    clientId: pack.string(),
});

const ErrorMsg = pack.object({
    type: pack.literal('error'),
    message: pack.string(),
});

const Stopped = pack.object({
    type: pack.literal('stopped'),
});

const NotifyMessageSchema = pack.union('type', [Ready, Heartbeat, ClientConnected, ClientDisconnected, ErrorMsg, Stopped]);

export const notifyCodec = pack.build(NotifyMessageSchema);

export type NotifyMessage = pack.SchemaType<typeof NotifyMessageSchema>;

// re-derive sub-types for convenience at call sites
export type ReadyMessage = pack.SchemaType<typeof Ready>;
export type HeartbeatMessage = pack.SchemaType<typeof Heartbeat>;
export type ProcessMetricsMessage = pack.SchemaType<typeof ProcessMetrics>;
export type ClientConnectedMessage = pack.SchemaType<typeof ClientConnected>;
export type ClientDisconnectedMessage = pack.SchemaType<typeof ClientDisconnected>;
export type ErrorMessage = pack.SchemaType<typeof ErrorMsg>;
export type StoppedMessage = pack.SchemaType<typeof Stopped>;

// --- room-side handle ---

/** the room's handle for notifying its managing server — connected over
 *  uds/tcp, or wired straight to the server's message handler when hosted
 *  in-process (`notify.direct`). */
export type Notifier = {
    send: (msg: NotifyMessage) => void;
    close: () => void;
};

// --- framing ---

// header: 4 bytes uint32 BE length
const HEADER_SIZE = 4;

/** wrap raw payload bytes in a length-prefixed frame */
export function encodeRawFrame(payload: Uint8Array): Uint8Array {
    const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
    frame.set(payload, HEADER_SIZE);
    return frame;
}

/** encode a notify message as a length-prefixed frame, ready to write to any pipe */
export function encodeNotifyFrame(msg: NotifyMessage): Uint8Array {
    return encodeRawFrame(notifyCodec.pack(msg));
}

/** streaming frame parser — handles partial reads and buffering across chunks.
 *  returns a push function that accepts raw chunks and invokes `onFrame` with
 *  each complete payload (header stripped). */
export function createFrameParser(onFrame: (payload: Uint8Array) => void): (data: Uint8Array) => void {
    let buffer: Uint8Array = new Uint8Array(0);

    return (data: Uint8Array) => {
        if (buffer.byteLength === 0) {
            buffer = data;
        } else {
            const merged = new Uint8Array(buffer.byteLength + data.byteLength);
            merged.set(buffer, 0);
            merged.set(data, buffer.byteLength);
            buffer = merged;
        }

        while (buffer.byteLength >= HEADER_SIZE) {
            const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            const payloadLength = view.getUint32(0, false);
            const totalFrameSize = HEADER_SIZE + payloadLength;

            if (buffer.byteLength < totalFrameSize) break;

            const payload = buffer.subarray(HEADER_SIZE, totalFrameSize);
            buffer = buffer.subarray(totalFrameSize);

            onFrame(payload);
        }
    };
}

/** streaming notify-message reader built on the frame parser.
 *  malformed frames are dropped via `onError` rather than thrown — callers are
 *  socket 'data' handlers which must not throw. */
export function createFrameReader(
    onMessage: (msg: NotifyMessage) => void,
    onError?: (err: unknown) => void,
): (data: Uint8Array) => void {
    return createFrameParser((payload) => {
        try {
            onMessage(notifyCodec.unpack(payload));
        } catch (err) {
            onError?.(err);
        }
    });
}
