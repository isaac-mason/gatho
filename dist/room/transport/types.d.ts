export type ClientSocket = {
    send(data: string | ArrayBuffer | Uint8Array, isBinary: boolean): void;
    close(code: number, reason: string): void;
    subscribe(topic: string): void;
};
export type UpgradeResult = {
    clientId: string;
    reconnecting?: boolean;
    joinData?: Record<string, unknown>;
};
export type TransportHandlers = {
    upgrade(query: string): UpgradeResult | null;
    open(clientId: string, socket: ClientSocket, joinData: Record<string, unknown>): void;
    reconnect(clientId: string, socket: ClientSocket): void;
    message(clientId: string, data: ArrayBuffer, isBinary: boolean): void;
    close(clientId: string, code: number): void;
};
export type TransportServer = {
    port: number;
    publish(topic: string, data: string | ArrayBuffer | Uint8Array, isBinary: boolean): void;
    close(): void;
};
export type TransportListenConfig = {
    port?: number;
};
export type Transport = {
    listen(handlers: TransportHandlers, config?: TransportListenConfig): Promise<TransportServer>;
};
