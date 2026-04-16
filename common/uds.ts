// uds ipc protocol — packcat-encoded, length-prefixed framing.
//
// frame format: length(4 bytes, uint32 BE) + payload(length bytes, packcat-encoded RoomMessage)
//
// messages flow one direction: room → server.

import type { Socket } from 'node:net';
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

const Heartbeat = pack.object({
    type: pack.literal('heartbeat'),
    timestamp: pack.float64(),
    metrics: ProcessMetrics,
    clientIds: pack.list(pack.string()),
});

const ClientConnected = pack.object({
    type: pack.literal('client-connected'),
    clientId: pack.string(),
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

const RoomMessageSchema = pack.union('type', [Ready, Heartbeat, ClientConnected, ClientDisconnected, ErrorMsg, Stopped]);

export const ipcCodec = pack.build(RoomMessageSchema);

export type RoomMessage = pack.SchemaType<typeof RoomMessageSchema>;

// re-derive sub-types for convenience at call sites
export type ReadyMessage = pack.SchemaType<typeof Ready>;
export type HeartbeatMessage = pack.SchemaType<typeof Heartbeat>;
export type ProcessMetricsMessage = pack.SchemaType<typeof ProcessMetrics>;
export type ClientConnectedMessage = pack.SchemaType<typeof ClientConnected>;
export type ClientDisconnectedMessage = pack.SchemaType<typeof ClientDisconnected>;
export type ErrorMessage = pack.SchemaType<typeof ErrorMsg>;
export type StoppedMessage = pack.SchemaType<typeof Stopped>;

// --- framing ---

// header: 4 bytes uint32 BE length
const HEADER_SIZE = 4;

export type UdsConnection = {
    send: (msg: RoomMessage) => void;
    close: () => void;
};

// encode and write a length-prefixed packcat frame
export function sendMessage(socket: Socket, msg: RoomMessage): void {
    const payload = ipcCodec.pack(msg);
    const frame = Buffer.alloc(HEADER_SIZE + payload.byteLength);
    frame.writeUInt32BE(payload.byteLength, 0);
    frame.set(payload, HEADER_SIZE);
    socket.write(frame);
}

// streaming frame reader — handles partial reads and buffering across data events
export class FrameReader {
    private buffer: Buffer = Buffer.alloc(0);
    private onMessage: (msg: RoomMessage) => void;

    constructor(onMessage: (msg: RoomMessage) => void) {
        this.onMessage = onMessage;
    }

    push(data: Buffer | Uint8Array): void {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.buffer = this.buffer.byteLength === 0 ? buf : Buffer.concat([this.buffer, buf]);

        while (this.buffer.byteLength >= HEADER_SIZE) {
            const payloadLength = this.buffer.readUInt32BE(0);
            const totalFrameSize = HEADER_SIZE + payloadLength;

            if (this.buffer.byteLength < totalFrameSize) break;

            const payload = this.buffer.subarray(HEADER_SIZE, totalFrameSize);
            this.buffer = this.buffer.subarray(totalFrameSize);

            this.onMessage(ipcCodec.unpack(payload));
        }
    }
}
