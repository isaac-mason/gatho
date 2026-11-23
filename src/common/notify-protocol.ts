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
// notify frames carry a hand-encoded NotifyMessage payload (see the wire layout below). the tcp channel
// additionally sends one raw frame first: the utf-8 auth token.

import { Reader, Writer } from './wire';

// --- message types ---

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
    // optional: not every room runtime can report process metrics (e.g. a
    // workerd isolate has no process.memoryUsage)
    metrics: ProcessMetricsMessage | undefined;
    clients: { clientId: string; tags: Record<string, string> }[];
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

export type NotifyMessage =
    | ReadyMessage
    | HeartbeatMessage
    | ClientConnectedMessage
    | ClientDisconnectedMessage
    | ErrorMessage
    | StoppedMessage;

// --- wire layout ---
//
// payload: u8 format, u8 tag, then the fields for the tag. numbers are little
// endian, str is a varint byte length plus utf-8, record is a varint entry
// count followed by (str key, str value) entries.
//
//   0 ready:               u16 port
//   1 heartbeat:           f64 timestamp, u8 hasMetrics (0 or 1),
//                          5 x f64 (rss, heapUsed, heapTotal, cpuUser, cpuSystem) when hasMetrics,
//                          varint clientCount, clientCount x (str clientId, record tags)
//   2 client-connected:    str clientId, str roomId, record tags
//   3 client-disconnected: str clientId
//   4 error:               str message
//   5 stopped:             no fields
//
// the pipe has no version handshake, so the format byte is how a server and
// room built from different gatho versions notice each other. it is above 0x7f
// so it cannot be mistaken for a tag from the older packcat encoding. bump it
// on any breaking change to the layout above.

const NOTIFY_FORMAT = 0x81;

const TAG_READY = 0;
const TAG_HEARTBEAT = 1;
const TAG_CLIENT_CONNECTED = 2;
const TAG_CLIENT_DISCONNECTED = 3;
const TAG_ERROR = 4;
const TAG_STOPPED = 5;

// smallest encodings, used to reject counts the remaining input cannot hold
const MIN_HEARTBEAT_CLIENT_BYTES = 2; // empty clientId length + empty tags count
const MIN_RECORD_ENTRY_BYTES = 2; // empty key length + empty value length

const writer = new Writer();
const reader = new Reader();

function writeTags(tags: Record<string, string>): void {
    const countAt = writer.reserveCount();
    let count = 0;
    for (const key in tags) {
        writer.str(key);
        writer.str(tags[key]);
        count++;
    }
    writer.patchCount(countAt, count);
}

function readTags(): Record<string, string> {
    const count = reader.count(MIN_RECORD_ENTRY_BYTES);
    const tags: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
        const key = reader.str();
        const value = reader.str();
        if (key === '__proto__') {
            Object.defineProperty(tags, key, { value, writable: true, enumerable: true, configurable: true });
        } else {
            tags[key] = value;
        }
    }
    return tags;
}

// write format byte, tag and fields for `msg` at the writer's position
function writeMessage(msg: NotifyMessage): void {
    writer.u8(NOTIFY_FORMAT);
    switch (msg.type) {
        case 'ready':
            writer.u8(TAG_READY);
            writer.u16(msg.port);
            break;
        case 'heartbeat': {
            writer.u8(TAG_HEARTBEAT);
            writer.f64(msg.timestamp);
            const metrics = msg.metrics;
            if (metrics === undefined) {
                writer.u8(0);
            } else {
                writer.u8(1);
                writer.f64(metrics.memoryRss);
                writer.f64(metrics.memoryHeapUsed);
                writer.f64(metrics.memoryHeapTotal);
                writer.f64(metrics.cpuUser);
                writer.f64(metrics.cpuSystem);
            }
            const clients = msg.clients;
            writer.varint(clients.length);
            for (let i = 0; i < clients.length; i++) {
                const client = clients[i];
                writer.str(client.clientId);
                writeTags(client.tags);
            }
            break;
        }
        case 'client-connected':
            writer.u8(TAG_CLIENT_CONNECTED);
            writer.str(msg.clientId);
            writer.str(msg.roomId);
            writeTags(msg.tags);
            break;
        case 'client-disconnected':
            writer.u8(TAG_CLIENT_DISCONNECTED);
            writer.str(msg.clientId);
            break;
        case 'error':
            writer.u8(TAG_ERROR);
            writer.str(msg.message);
            break;
        case 'stopped':
            writer.u8(TAG_STOPPED);
            break;
        default:
            throw new Error(`unknown notify message type: ${String((msg as { type?: unknown }).type)}`);
    }
}

function readMessage(): NotifyMessage {
    const format = reader.u8();
    if (format !== NOTIFY_FORMAT) {
        throw new Error(
            `notify format mismatch (got 0x${format.toString(16).padStart(2, '0')}, expected 0x${NOTIFY_FORMAT.toString(16)}), is the room built from a different gatho version?`,
        );
    }
    const tag = reader.u8();
    switch (tag) {
        case TAG_READY:
            return { type: 'ready', port: reader.u16() };
        case TAG_HEARTBEAT: {
            const timestamp = reader.f64();
            const hasMetrics = reader.u8();
            let metrics: ProcessMetricsMessage | undefined;
            if (hasMetrics === 1) {
                const memoryRss = reader.f64();
                const memoryHeapUsed = reader.f64();
                const memoryHeapTotal = reader.f64();
                const cpuUser = reader.f64();
                const cpuSystem = reader.f64();
                metrics = { memoryRss, memoryHeapUsed, memoryHeapTotal, cpuUser, cpuSystem };
            } else if (hasMetrics !== 0) {
                throw new Error(`invalid heartbeat metrics flag: ${hasMetrics}`);
            }
            const count = reader.count(MIN_HEARTBEAT_CLIENT_BYTES);
            const clients: HeartbeatMessage['clients'] = [];
            for (let i = 0; i < count; i++) {
                const clientId = reader.str();
                const tags = readTags();
                clients.push({ clientId, tags });
            }
            return { type: 'heartbeat', timestamp, metrics, clients };
        }
        case TAG_CLIENT_CONNECTED: {
            const clientId = reader.str();
            const roomId = reader.str();
            const tags = readTags();
            return { type: 'client-connected', clientId, roomId, tags };
        }
        case TAG_CLIENT_DISCONNECTED:
            return { type: 'client-disconnected', clientId: reader.str() };
        case TAG_ERROR:
            return { type: 'error', message: reader.str() };
        case TAG_STOPPED:
            return { type: 'stopped' };
        default:
            throw new Error(`unknown notify message tag: 0x${tag.toString(16).padStart(2, '0')}`);
    }
}

/** encoder and decoder for the notify payload (no length framing) */
export const notifyCodec = {
    pack(msg: NotifyMessage): Uint8Array<ArrayBuffer> {
        writer.begin();
        writeMessage(msg);
        return writer.finish();
    },
    /** decode one payload. throws an Error on anything malformed. */
    unpack(payload: Uint8Array): NotifyMessage {
        reader.reset(payload, 0);
        try {
            const msg = readMessage();
            reader.finish();
            return msg;
        } finally {
            reader.release();
        }
    },
};

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
    writer.begin();
    writer.ensure(HEADER_SIZE);
    writer.pos = HEADER_SIZE;
    writeMessage(msg);
    const payloadLength = writer.pos - HEADER_SIZE;
    const frame = writer.finish();
    frame[0] = payloadLength >>> 24;
    frame[1] = (payloadLength >>> 16) & 0xff;
    frame[2] = (payloadLength >>> 8) & 0xff;
    frame[3] = payloadLength & 0xff;
    return frame;
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
