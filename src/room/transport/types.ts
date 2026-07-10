/*
 * transport abstraction layer.
 * may in future support swapping out ws for webtransport
 */

export type ClientSocket = {
    send(data: string | ArrayBuffer | Uint8Array, isBinary: boolean): void;
    close(code: number, reason: string): void;
    subscribe(topic: string): void;
    // bytes queued to send but not yet flushed to the os (the kernel/userland
    // outbound buffer). this is the backpressure signal — gatho exposes it but
    // ships no automatic eviction policy; the app decides how to pace large sends
    // and whether to drop stalled consumers. transports that cannot observe this
    // portably return 0.
    bufferedAmount(): number;
};

export type UpgradeResult = {
    clientId: string;
    reconnecting?: boolean;
    joinData?: Record<string, unknown>;
    // driver-internal tags, forwarded from the jwt so the room can echo them
    // back over ipc when reporting client-connected. opaque to room code.
    tags?: Record<string, string>;
    // set when the client's protocol version (gv query param) is missing or
    // doesn't match the server. the upgrade still completes so the client gets
    // a readable auth_error frame instead of a raw 4xx (same rationale as the
    // invalid-session path); open()/reconnect() send the message and close 4000.
    versionMismatch?: string;
};

export type TransportHandlers = {
    // called during http upgrade. returns client identity if auth passes, null to reject.
    // query is the raw query string (e.g. "token=abc123").
    // may be async (jwt verification uses WebCrypto) — transports must await it
    // before completing the upgrade.
    upgrade(query: string): UpgradeResult | null | Promise<UpgradeResult | null>;

    // called when a new ws connection opens. socket is the opaque handle.
    // joinData is the arbitrary data from sdk.join({ data }), extracted from the jwt.
    // tags is the driver-internal tag bag from the jwt — opaque, forwarded over ipc.
    // versionMismatch (when set) means the upgrade was completed only to deliver
    // a readable protocol-version error before closing 4000.
    open(
        clientId: string,
        socket: ClientSocket,
        joinData: Record<string, unknown>,
        tags: Record<string, string>,
        versionMismatch?: string,
    ): void;

    // called when a reconnecting client's ws connection opens.
    // the transport swaps internal maps and calls this instead of open().
    // versionMismatch (when set) means the upgrade was completed only to deliver
    // a readable protocol-version error before closing 4000.
    reconnect(clientId: string, socket: ClientSocket, versionMismatch?: string): void;

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
