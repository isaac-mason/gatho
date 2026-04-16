// shared uds framing protocol used by both room and server
//
// frame format: tag(1 byte) + length(4 bytes, uint32 BE) + payload(length bytes)
//   tag 0x00 = json text frame (utf-8 JSON, parsed with JSON.parse)
//   tag 0x01 = binary data frame (raw bytes, delivered as Uint8Array)
//
// messages with binary payloads (Uint8Array in data field) are sent as two frames:
// a json frame with { binary: true } replacing the data field, then a binary frame
// with the raw bytes. text messages are a single json frame.

import type { Socket } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonMessage = Record<string, any>;

export type Frame = {
    tag: number;
    payload: Buffer;
};

export type UdsConnection = {
    send: (msg: JsonMessage) => void;
    close: () => void;
};

// frame tags
export const TAG_JSON = 0x00;
export const TAG_BINARY = 0x01;

// header: 1 byte tag + 4 bytes uint32 BE length
export const HEADER_SIZE = 5;

// --- frame writing ---

export function buildFrame(tag: number, payload: Uint8Array | string): Buffer {
    const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
    const frame = Buffer.alloc(HEADER_SIZE + payloadBuf.byteLength);
    frame[0] = tag;
    frame.writeUInt32BE(payloadBuf.byteLength, 1);
    frame.set(payloadBuf, HEADER_SIZE);
    return frame;
}

export function writeFrame(socket: Socket, tag: number, payload: Uint8Array | string): void {
    socket.write(buildFrame(tag, payload));
}

// send an ipc message. handles the json/binary split transparently.
// binary-payload messages are sent as two frames batched into one write call.
export function sendMessage(socket: Socket, msg: JsonMessage): void {
    const rec = msg as Record<string, unknown>;
    if ('data' in rec && rec.data instanceof Uint8Array) {
        const { data, ...rest } = rec;
        const jsonFrame = buildFrame(TAG_JSON, JSON.stringify({ ...rest, binary: true }));
        const binFrame = buildFrame(TAG_BINARY, data as Uint8Array);
        const combined = Buffer.alloc(jsonFrame.byteLength + binFrame.byteLength);
        combined.set(jsonFrame, 0);
        combined.set(binFrame, jsonFrame.byteLength);
        socket.write(combined);
        return;
    }
    socket.write(buildFrame(TAG_JSON, JSON.stringify(msg)));
}

// --- frame reading ---

// streaming frame reader — handles partial reads and buffering across data events
export class FrameReader {
    private buffer: Buffer = Buffer.alloc(0);
    private onFrame: (frame: Frame) => void;

    constructor(onFrame: (frame: Frame) => void) {
        this.onFrame = onFrame;
    }

    push(data: Buffer | Uint8Array): void {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.buffer = this.buffer.byteLength === 0 ? buf : Buffer.concat([this.buffer, buf]);

        while (this.buffer.byteLength >= HEADER_SIZE) {
            const tag = this.buffer[0];
            const payloadLength = this.buffer.readUInt32BE(1);
            const totalFrameSize = HEADER_SIZE + payloadLength;

            if (this.buffer.byteLength < totalFrameSize) break;

            const payload = Buffer.from(this.buffer.subarray(HEADER_SIZE, totalFrameSize));
            this.buffer = this.buffer.subarray(totalFrameSize);

            this.onFrame({ tag, payload });
        }
    }
}

// reassembles binary-flagged messages into typed ipc messages
export function createMessageReceiver(handler: (msg: JsonMessage) => void): (frame: Frame) => void {
    let pendingJsonMsg: Record<string, unknown> | null = null;

    return (frame: Frame) => {
        if (frame.tag === TAG_JSON) {
            const parsed = JSON.parse(frame.payload.toString('utf-8')) as Record<string, unknown>;
            if (parsed.binary === true) {
                pendingJsonMsg = parsed;
                return;
            }
            handler(parsed as unknown as JsonMessage);
        } else if (frame.tag === TAG_BINARY) {
            if (pendingJsonMsg) {
                pendingJsonMsg.data = new Uint8Array(frame.payload);
                delete pendingJsonMsg.binary;
                handler(pendingJsonMsg as unknown as JsonMessage);
                pendingJsonMsg = null;
            }
            // binary frame without pending json — protocol violation, drop
        }
    };
}
