export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type SendOptions = {
    reliable?: boolean;
};
export type SendMessage = string | ArrayBuffer | ArrayBufferView | Blob;
export type ReceiveMessage = string | ArrayBuffer;
export type CloseCause = 'consented' | 'auth' | 'session' | 'reconnect-failed' | 'buffer-overflow' | 'initial-connect-failed' | 'server';
export type CloseInfo = {
    code: number;
    reason: string;
    cause: CloseCause;
};
export type ConnectHandlers = {
    onOpen?: () => void;
    onMessage?: (message: ReceiveMessage) => void;
    onDrop?: () => void;
    onReconnect?: () => void;
    onAuthError?: (error: unknown) => void;
    onClose?: (info: CloseInfo) => void;
    onError?: (error: Event) => void;
};
export type RoomConnection = {
    readonly state: ConnectionState;
    readonly clientId: string | null;
    send(message: SendMessage, options?: SendOptions): void;
    close(): void;
};
export declare function connect(url: string, handlers?: ConnectHandlers): RoomConnection;
