import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { createFrameReader, log, type RoomMessage, type UdsConnection } from 'gatho/common';

export function listenOnSocket(
    socketPath: string,
    onMessage: (msg: RoomMessage) => void,
    options?: { timeoutMs?: number; onClose?: () => void },
): Promise<UdsConnection> {
    return new Promise((resolve, reject) => {
        const dir = dirname(socketPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

        // clean up stale socket file if present
        try {
            unlinkSync(socketPath);
        } catch {
            // not there, fine
        }

        const server = createServer((socket) => {
            if (settled) {
                socket.destroy();
                return;
            }

            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }

            server.close();

            const push = createFrameReader(onMessage, (err) => {
                log.error('uds: malformed frame dropped', { socketPath, err });
            });
            const onClose = options?.onClose;

            // absorb socket errors — a broken pipe or reset should not become an
            // uncaught EventEmitter error. the 'close' event fires after 'error',
            // so cleanupRoom is still triggered via the onClose callback.
            socket.on('error', (err) => {
                log.error('uds: socket error', { socketPath, err });
            });
            socket.on('data', (chunk: Buffer) => push(chunk));
            socket.on('close', () => onClose?.());

            resolve({
                send() {
                    // server never sends to room — this is a no-op placeholder
                    // to satisfy UdsConnection interface
                    throw new Error('server-side uds does not send messages');
                },
                close() {
                    socket.destroy();
                    try {
                        unlinkSync(socketPath);
                    } catch {
                        // already gone
                    }
                },
            });
        });

        server.on('error', (error) => {
            if (!settled) {
                settled = true;
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                reject(error);
            }
        });

        server.listen(socketPath);

        if (options?.timeoutMs !== undefined) {
            timeoutHandle = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    server.close();
                    try {
                        unlinkSync(socketPath);
                    } catch (e) {
                        console.warn(`uds: failed to clean up socket file at ${socketPath} after timeout`, e);
                    }
                    reject(new Error(`uds: no connection within ${options.timeoutMs}ms on ${socketPath}`));
                }
            }, options.timeoutMs);
        }
    });
}

export type UdsServer = {
    close: () => void;
};

export async function createUdsServer(
    socketPath: string,
    onMessage: (msg: RoomMessage) => void,
    options?: { timeoutMs?: number; onClose?: () => void },
): Promise<UdsServer> {
    const conn = await listenOnSocket(socketPath, onMessage, options);
    return {
        close() {
            conn.close();
        },
    };
}
