import * as pack from 'packcat';
export declare const PROTOCOL_VERSION = 1;
export declare const FRAME_PROTOCOL = 0;
export declare const FRAME_USER_TEXT = 1;
export declare const FRAME_USER_BINARY = 2;
declare const ProtocolMessage: {
    type: "union";
    key: "type";
    variants: [{
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "session";
            };
            token: {
                type: "string";
            };
            clientId: {
                type: "string";
            };
        };
    }, {
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "auth_error";
            };
            error: {
                type: "string";
            };
        };
    }, {
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "leave";
            };
        };
    }];
};
export type ProtocolMessage = pack.SchemaType<typeof ProtocolMessage>;
export type Frame = {
    frame: 'protocol';
    message: ProtocolMessage;
} | {
    frame: 'user_text';
    text: string;
} | {
    frame: 'user_binary';
    data: ArrayBuffer;
};
export declare function packProtocol(msg: ProtocolMessage): Uint8Array<ArrayBuffer>;
export declare function packUserText(text: string): Uint8Array<ArrayBuffer>;
export declare function packUserBinary(data: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer>;
export declare function unpackFrame(data: ArrayBuffer | Uint8Array): Frame;
export declare function frameUserMessage(message: string | ArrayBuffer | ArrayBufferView | Blob): Uint8Array<ArrayBuffer>;
export {};
