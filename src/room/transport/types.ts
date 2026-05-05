/*
 * transport abstraction layer.
 * may in future support swapping out ws for webtransport
 */

export type ClientSocket = {
    send(data: string | ArrayBuffer | Uint8Array, isBinary: boolean): void;
    close(code: number, reason: string): void;
    subscribe(topic: string): void;
};

export type UpgradeResult = {
    clientId: string;
    reconnecting?: boolean;
    joinData?: Record<string, unknown>;
    // driver-internal tags, forwarded from the jwt so the room can echo them
    // back over ipc when reporting client-connected. opaque to room code.
    tags?: Record<string, string>;
};

export type TransportHandlers = {
    // called during http upgrade. returns client identity if auth passes, null to reject.
    // query is the raw query string (e.g. "token=abc123").
    upgrade(query: string): UpgradeResult | null;

    // called when a new ws connection opens. socket is the opaque handle.
    // joinData is the arbitrary data from sdk.join({ data }), extracted from the jwt.
    // tags is the driver-internal tag bag from the jwt — opaque, forwarded over ipc.
    open(
        clientId: string,
        socket: ClientSocket,
        joinData: Record<string, unknown>,
        tags: Record<string, string>,
    ): void;

    // called when a reconnecting client's ws connection opens.
    // the transport swaps internal maps and calls this instead of open().
    reconnect(clientId: string, socket: ClientSocket): void;

    // called when a message is received from a client.
    message(clientId: string, data: ArrayBuffer, isBinary: boolean): void;

    // called when a ws connection closes. code is the websocket close code.
    close(clientId: string, code: number): void;
};

export type TransportServer = {
    // the port the server is listening on
    port: number;

    // publish a message to all subscribers of a topic (pub/sub fan-out)
    publish(topic: string, data: string | ArrayBuffer | Uint8Array, isBinary: boolean): void;

    // shut down the server
    close(): void;
};

export type TransportListenConfig = {
    // port to listen on. 0 = os-assigned (default).
    port?: number;
};

// what start-room.ts receives — call listen() to start the ws server.
// each transport factory (bun, uws, ws) returns one of these.
export type Transport = {
    listen(handlers: TransportHandlers, config?: TransportListenConfig): Promise<TransportServer>;
};
