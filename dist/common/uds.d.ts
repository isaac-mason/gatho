import type { Socket } from 'node:net';
export type JsonMessage = Record<string, any>;
export type Frame = {
    tag: number;
    payload: Buffer;
};
export type UdsConnection = {
    send: (msg: JsonMessage) => void;
    close: () => void;
};
export declare const TAG_JSON = 0;
export declare const TAG_BINARY = 1;
export declare const HEADER_SIZE = 5;
export declare function buildFrame(tag: number, payload: Uint8Array | string): Buffer;
export declare function writeFrame(socket: Socket, tag: number, payload: Uint8Array | string): void;
export declare function sendMessage(socket: Socket, msg: JsonMessage): void;
export declare class FrameReader {
    private buffer;
    private onFrame;
    constructor(onFrame: (frame: Frame) => void);
    push(data: Buffer | Uint8Array): void;
}
export declare function createMessageReceiver(handler: (msg: JsonMessage) => void): (frame: Frame) => void;
