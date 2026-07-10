export type { Notifier, NotifyMessage, } from '../common/notify-protocol';
export { createFrameParser, encodeNotifyFrame, encodeRawFrame, notifyCodec } from '../common/notify-protocol';
export type { CreateOptions, ServerConfig } from './start';
export { create } from './start';
export type { WsTransportConfig } from './transport/index';
export { wsTransport } from './transport/index';
export type { ClientSocket, Transport, TransportHandlers, TransportListenConfig, TransportServer, } from './transport/types';
export { CloseCode } from '../common/close-code';
export type AuthResult<ClientData> = {
    ok: true;
    data: ClientData;
} | {
    ok: false;
    error: unknown;
};
export type SendOptions = {
    reliable?: boolean;
};
export type Client<ClientData = Record<string, unknown>> = {
    readonly id: string;
    readonly data: ClientData;
    send(message: string | ArrayBuffer | ArrayBufferView, options?: SendOptions): void;
    allowReconnection(windowMs: number): void;
    disconnect(): void;
    readonly bufferedAmount: number;
};
export type ClientCollection<ClientData> = {
    get(id: string): Client<ClientData> | undefined;
    has(id: string): boolean;
    count(): number;
    forEach(callback: (client: Client<ClientData>, id: string) => void): void;
    ids(): string[];
    all(): Client<ClientData>[];
    [Symbol.iterator](): IterableIterator<Client<ClientData>>;
};
export type BroadcastOptions<ClientData = Record<string, unknown>> = {
    reliable?: boolean;
    except?: Client<ClientData> | Client<ClientData>[];
};
export type Room<ClientData = Record<string, unknown>> = {
    readonly roomId: string;
    readonly roomType: string;
    readonly serverId: string | undefined;
    broadcast(message: string | ArrayBuffer | ArrayBufferView, options?: BroadcastOptions<ClientData>): void;
    readonly clients: ClientCollection<ClientData>;
    start(): Promise<void>;
    stop(): Promise<void>;
};
