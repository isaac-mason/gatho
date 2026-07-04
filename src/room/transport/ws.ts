// ws transport — uses the `ws` npm package.
// works on node and bun. zero native addons.
//
// pub/sub is implemented manually since ws doesn't have built-in
// topic-based broadcast like uWebSockets.js.

import type { WebSocket } from 'ws';
import type { ClientSocket, Transport, TransportHandlers, TransportListenConfig, TransportServer } from './types';

// ws-specific configuration — pass through to the ws library directly.
// we don't paper over differences with a shared config type.
export type WsTransportConfig = {
    // max payload in bytes (default 1mb)
    maxPayload?: number;
    // enable per-message deflate compression (default false — binary game data
    // doesn't compress well and adds latency)
    perMessageDeflate?: boolean;
};

// per-connection state stored alongside the raw ws socket
type ConnectionState = {
    clientId: string;
    topics: Set<string>;
};

export function wsTransport(config?: WsTransportConfig): Transport {
    return {
        async listen(handlers: TransportHandlers, listenConfig?: TransportListenConfig): Promise<TransportServer> {
            // `ws` and `http` load lazily, inside listen() — same pattern as
            // node:net in room/ipc.ts. a bundle for a runtime that supplies its
            // own transport (e.g. a workerd isolate) carries these as inert
            // dynamic imports and never executes them, so no shims are needed.
            const { createServer } = await import('http');
            const { WebSocketServer } = await import('ws');

            return new Promise((resolve, reject) => {
                const httpServer = createServer((_req, res) => {
                    // reject plain http requests — this server is ws-only
                    res.writeHead(426, { 'Content-Type': 'text/plain' });
                    res.end('upgrade required');
                });

                const wss = new WebSocketServer({
                    noServer: true,
                    maxPayload: config?.maxPayload ?? 1024 * 1024,
                    perMessageDeflate: config?.perMessageDeflate ?? false,
                });

                // connection state keyed by ws instance
                const connections = new Map<WebSocket, ConnectionState>();

                // reverse lookup: clientId -> ws
                const clientSockets = new Map<string, WebSocket>();

                // topic subscriptions: topic -> set of ws instances
                const topics = new Map<string, Set<WebSocket>>();

                // handle http upgrade — this is where auth happens.
                // upgrade() may be async (webcrypto jwt verify); the raw socket just
                // buffers until handleUpgrade consumes it.
                httpServer.on('upgrade', (req, socket, head) => {
                    const query = req.url?.split('?')[1] ?? '';

                    Promise.resolve(handlers.upgrade(query))
                        .then((result) => {
                            if (socket.destroyed) return;
                            if (!result) {
                                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                                socket.destroy();
                                return;
                            }
                            completeUpgrade(req, socket, head, result);
                        })
                        .catch(() => {
                            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                            socket.destroy();
                        });
                });

                type UpgradeResultResolved = NonNullable<Awaited<ReturnType<TransportHandlers['upgrade']>>>;

                function completeUpgrade(
                    req: import('http').IncomingMessage,
                    socket: import('stream').Duplex,
                    head: Buffer,
                    result: UpgradeResultResolved,
                ): void {
                    const { clientId, reconnecting } = result;
                    const joinData = result.joinData ?? {};
                    const tags = result.tags ?? {};

                    wss.handleUpgrade(req, socket, head, (ws) => {
                        // if reconnecting, clean up the old socket for this clientId
                        // (it may already be gone if the old connection closed cleanly)
                        const oldWs = clientSockets.get(clientId);
                        if (oldWs) {
                            const oldState = connections.get(oldWs);
                            if (oldState) {
                                for (const topic of oldState.topics) {
                                    const subs = topics.get(topic);
                                    if (subs) {
                                        subs.delete(oldWs);
                                        if (subs.size === 0) {
                                            topics.delete(topic);
                                        }
                                    }
                                }
                            }
                            connections.delete(oldWs);
                            // don't call oldWs.close() — it's already dead or will be
                        }

                        const state: ConnectionState = {
                            clientId,
                            topics: new Set(),
                        };
                        connections.set(ws, state);
                        clientSockets.set(clientId, ws);

                        // build the WsSocket abstraction for start.ts
                        const wsSocket: ClientSocket = {
                            send(data, isBinary) {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(data, { binary: isBinary });
                                }
                            },
                            close(code, reason) {
                                ws.close(code, reason);
                            },
                            subscribe(topic) {
                                state.topics.add(topic);
                                let subs = topics.get(topic);
                                if (!subs) {
                                    subs = new Set();
                                    topics.set(topic, subs);
                                }
                                subs.add(ws);
                            },
                        };

                        if (reconnecting) {
                            handlers.reconnect(clientId, wsSocket);
                        } else {
                            handlers.open(clientId, wsSocket, joinData, tags);
                        }

                        ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
                            // normalize to arraybuffer — consistent with transport interface.
                            // we copy into a fresh ArrayBuffer to avoid SharedArrayBuffer issues
                            // with Buffer.buffer on some runtimes.
                            let ab: ArrayBuffer;
                            if (data instanceof ArrayBuffer) {
                                ab = data;
                            } else if (Buffer.isBuffer(data)) {
                                const copy = new Uint8Array(data.byteLength);
                                copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                                ab = copy.buffer as ArrayBuffer;
                            } else {
                                // Buffer[] (fragments) — concat then copy
                                const buf = Buffer.concat(data);
                                const copy = new Uint8Array(buf.byteLength);
                                copy.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
                                ab = copy.buffer as ArrayBuffer;
                            }
                            handlers.message(clientId, ab, isBinary);
                        });

                        ws.on('close', (code: number) => {
                            // clean up topic subscriptions
                            for (const topic of state.topics) {
                                const subs = topics.get(topic);
                                if (subs) {
                                    subs.delete(ws);
                                    if (subs.size === 0) {
                                        topics.delete(topic);
                                    }
                                }
                            }

                            connections.delete(ws);
                            clientSockets.delete(clientId);

                            handlers.close(clientId, code);
                        });
                    });
                }

                // listen on configured port, or 0 for os-assigned
                httpServer.listen(listenConfig?.port ?? 0, () => {
                    const addr = httpServer.address();
                    if (!addr || typeof addr === 'string') {
                        reject(new Error('failed to get server address'));
                        return;
                    }

                    const server: TransportServer = {
                        port: addr.port,

                        publish(topic, data, isBinary) {
                            const subs = topics.get(topic);
                            if (!subs) return;

                            for (const ws of subs) {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(data, { binary: isBinary });
                                }
                            }
                        },

                        close() {
                            // close all ws connections
                            for (const ws of connections.keys()) {
                                ws.close(1001, 'server shutting down');
                            }
                            wss.close();
                            httpServer.close();
                        },
                    };

                    resolve(server);
                });

                httpServer.on('error', reject);
            });
        },
    };
}
