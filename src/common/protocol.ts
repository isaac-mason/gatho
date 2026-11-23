// wire framing for gatho websocket connections.
//
// every websocket message is a binary frame. byte 0 is the frame type:
//   0x00 = protocol message (tag byte and fields follow)
//   0x01 = user text message (raw utf-8 bytes follow)
//   0x02 = user binary message (raw bytes follow)
//
// protocol messages are hand-encoded, see the layouts on the tag constants.
// user messages pass through with minimal overhead (1 byte prefix).

import { Reader, Writer } from './wire';

// gatho wire protocol version. client and server versions must match exactly,
// the room rejects any connect whose `gv` query param is missing or different.
// bump this on any breaking change to the frame layout or protocol messages.
export const PROTOCOL_VERSION = 2;

// frame type constants
export const FRAME_PROTOCOL = 0x00;
export const FRAME_USER_TEXT = 0x01;
export const FRAME_USER_BINARY = 0x02;

// protocol message tags, the byte after the frame type
//   0 session:    str token, str clientId
//   1 auth_error: str error
//   2 leave:      no fields
// where str is a varint byte length followed by utf-8 bytes
const TAG_SESSION = 0;
const TAG_AUTH_ERROR = 1;
const TAG_LEAVE = 2;

export type ProtocolMessage =
    | {
          type: 'session';
          token: string;
          // the client's own id, assigned by the room. lets the browser client learn
          // its identity without the app plumbing it through by hand.
          clientId: string;
      }
    | { type: 'auth_error'; error: string }
    | { type: 'leave' };

// decoded frame — discriminated union returned by unpackFrame
export type Frame =
    | { frame: 'protocol'; message: ProtocolMessage }
    | { frame: 'user_text'; text: string }
    | { frame: 'user_binary'; data: ArrayBuffer };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const writer = new Writer();
const reader = new Reader();

// pack a protocol message: [0x00, tag, ...fields]
export function packProtocol(msg: ProtocolMessage): Uint8Array<ArrayBuffer> {
    writer.begin();
    writer.u8(FRAME_PROTOCOL);
    switch (msg.type) {
        case 'session':
            writer.u8(TAG_SESSION);
            writer.str(msg.token);
            writer.str(msg.clientId);
            break;
        case 'auth_error':
            writer.u8(TAG_AUTH_ERROR);
            writer.str(msg.error);
            break;
        case 'leave':
            writer.u8(TAG_LEAVE);
            break;
        default:
            throw new Error(`unknown protocol message type: ${(msg satisfies never as { type: string }).type}`);
    }
    return writer.finish();
}

// decode the protocol message whose tag byte is at `offset`
function unpackProtocolMessage(view: Uint8Array, offset: number): ProtocolMessage {
    reader.reset(view, offset);
    try {
        const tag = reader.u8();
        let message: ProtocolMessage;
        switch (tag) {
            case TAG_SESSION: {
                const token = reader.str();
                const clientId = reader.str();
                message = { type: 'session', token, clientId };
                break;
            }
            case TAG_AUTH_ERROR:
                message = { type: 'auth_error', error: reader.str() };
                break;
            case TAG_LEAVE:
                message = { type: 'leave' };
                break;
            default:
                throw new Error(`unknown protocol message tag: 0x${tag.toString(16).padStart(2, '0')}`);
        }
        reader.finish();
        return message;
    } finally {
        reader.release();
    }
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

    switch (type) {
        case FRAME_PROTOCOL:
            return { frame: 'protocol', message: unpackProtocolMessage(view, 1) };
        case FRAME_USER_TEXT:
            return { frame: 'user_text', text: textDecoder.decode(view.subarray(1)) };
        case FRAME_USER_BINARY:
            // return a copy as ArrayBuffer so the caller owns the memory
            return {
                frame: 'user_binary',
                data: view.slice(1).buffer as ArrayBuffer,
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
