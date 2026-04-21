// wire framing for gatho websocket connections.
//
// every websocket message is a binary frame. byte 0 is the frame type:
//   0x00 = protocol message (packcat-encoded payload follows)
//   0x01 = user text message (raw utf-8 bytes follow)
//   0x02 = user binary message (raw bytes follow)
//
// protocol messages use packcat for the payload after the type byte.
// user messages pass through with minimal overhead (1 byte prefix).

import * as pack from 'packcat';

// frame type constants
export const FRAME_PROTOCOL = 0x00;
export const FRAME_USER_TEXT = 0x01;
export const FRAME_USER_BINARY = 0x02;

// protocol message schemas
const Session = pack.object({
    type: pack.literal('session'),
    token: pack.string(),
});

const AuthError = pack.object({
    type: pack.literal('auth_error'),
    error: pack.string(),
});

const Leave = pack.object({
    type: pack.literal('leave'),
});

const ProtocolMessage = pack.union('type', [Session, AuthError, Leave]);
const codec = pack.build(ProtocolMessage);

export type ProtocolMessage = pack.SchemaType<typeof ProtocolMessage>;

// decoded frame — discriminated union returned by unpackFrame
export type Frame =
    | { frame: 'protocol'; message: ProtocolMessage }
    | { frame: 'user_text'; text: string }
    | { frame: 'user_binary'; data: ArrayBuffer };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// pack a protocol message: [0x00, ...packcat bytes]
export function packProtocol(msg: ProtocolMessage): Uint8Array<ArrayBuffer> {
    const payload = codec.pack(msg);
    const frame = new Uint8Array(1 + payload.byteLength);
    frame[0] = FRAME_PROTOCOL;
    frame.set(payload, 1);
    return frame;
}

// pack a user text message: [0x01, ...utf-8 bytes]
export function packUserText(text: string): Uint8Array<ArrayBuffer> {
    const encoded = textEncoder.encode(text);
    const frame = new Uint8Array(1 + encoded.byteLength);
    frame[0] = FRAME_USER_TEXT;
    frame.set(encoded, 1);
    return frame;
}

// pack a user binary message: [0x02, ...raw bytes]
export function packUserBinary(data: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const frame = new Uint8Array(1 + view.byteLength);
    frame[0] = FRAME_USER_BINARY;
    frame.set(view, 1);
    return frame;
}

// unpack any frame. accepts ArrayBuffer or Uint8Array.
export function unpackFrame(data: ArrayBuffer | Uint8Array): Frame {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (view.byteLength === 0) {
        throw new Error('empty frame');
    }

    const type = view[0];
    const payload = view.subarray(1);

    switch (type) {
        case FRAME_PROTOCOL:
            return { frame: 'protocol', message: codec.unpack(payload) };
        case FRAME_USER_TEXT:
            return { frame: 'user_text', text: textDecoder.decode(payload) };
        case FRAME_USER_BINARY:
            // return a copy as ArrayBuffer so the caller owns the memory
            return {
                frame: 'user_binary',
                data: payload.slice().buffer as ArrayBuffer,
            };
        default:
            throw new Error(`unknown frame type: 0x${type.toString(16).padStart(2, '0')}`);
    }
}

export function frameUserMessage(message: string | ArrayBuffer | ArrayBufferView | Blob): Uint8Array<ArrayBuffer> {
    if (typeof message === 'string') return packUserText(message);
    if (message instanceof ArrayBuffer) return packUserBinary(message);
    if (message instanceof Blob) {
        // blob should have been converted before reaching here — this is a
        // fallback that shouldn't happen in practice. callers should await
        // blob.arrayBuffer() first.
        throw new Error('Blob must be converted to ArrayBuffer before framing');
    }
    // ArrayBufferView (Uint8Array, Float32Array, etc.)
    return packUserBinary(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
}