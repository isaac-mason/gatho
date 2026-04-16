export type { ServerConfig, StartOptions } from './start';
export { start } from './start';
export type { WsTransportConfig } from './transport/index';
export { wsTransport } from './transport/index';
export type { ClientSocket as WsSocket, Transport as RoomTransport, TransportHandlers, TransportListenConfig, TransportServer, } from './transport/types';
export declare const CloseCode: {
    readonly NORMAL: 1000;
    readonly GOING_AWAY: 1001;
    readonly ABNORMAL: 1006;
    readonly CONSENTED: 4000;
};
export type AuthResult<ClientData> = {
    ok: true;
    data: ClientData;
} | {
    ok: false;
    error: unknown;
};
export declare const auth: {
    ok<T = Record<string, never>>(data?: T): AuthResult<T>;
    fail(error: unknown): {
        ok: false;
        error: unknown;
    };
};
export type Client<ClientData = Record<string, unknown>> = {
    id: string;
    data: ClientData;
};
export type ClientCollection<ClientData> = {
    get(id: string): Client<ClientData> | undefined;
    has(id: string): boolean;
    count(): number;
    forEach(callback: (client: Client<ClientData>, id: string) => void): void;
    ids(): string[];
    all(): Client<ClientData>[];
};
export type SendOptions = {
    reliable?: boolean;
};
export type Room<ClientData = Record<string, unknown>> = {
    readonly roomId: string;
    readonly roomType: string;
    readonly serverId: string | undefined;
    send(client: Client<ClientData>, message: unknown, options?: SendOptions): void;
    broadcast(message: unknown, options?: SendOptions): void;
    readonly clients: ClientCollection<ClientData>;
    allowReconnection(client: Client<ClientData>, windowMs: number): void;
    disconnect(client: Client<ClientData>): void;
    stop(): Promise<void>;
};
