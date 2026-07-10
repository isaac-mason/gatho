export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type SendOptions = {
    reliable?: boolean;
};
export type SendMessage = string | ArrayBuffer | ArrayBufferView | Blob;
export type ReceiveMessage = string | ArrayBuffer;
export type RoomConnection = {
    readonly state: ConnectionState;
    readonly clientId: string | null;
    send(message: SendMessage, options?: SendOptions): void;
    on(event: 'open', callback: () => void): () => void;
    on(event: 'message', callback: (message: ReceiveMessage) => void): () => void;
    on(event: 'drop', callback: () => void): () => void;
    on(event: 'reconnect', callback: () => void): () => void;
    on(event: 'authError', callback: (error: unknown) => void): () => void;
    on(event: 'close', callback: (code: number, reason: string) => void): () => void;
    on(event: 'error', callback: (error: Event) => void): () => void;
    off(event: 'open', callback: () => void): void;
    off(event: 'message', callback: (message: ReceiveMessage) => void): void;
    off(event: 'drop', callback: () => void): void;
    off(event: 'reconnect', callback: () => void): void;
    off(event: 'authError', callback: (error: unknown) => void): void;
    off(event: 'close', callback: (code: number, reason: string) => void): void;
    off(event: 'error', callback: (error: Event) => void): void;
    close(): void;
};
export declare function connect(url: string): RoomConnection;
