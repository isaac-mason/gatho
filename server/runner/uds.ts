import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { createMessageReceiver, FrameReader, type JsonMessage, sendMessage, type UdsConnection } from '../../common/uds';
import type { RoomMessage } from './ipc-types';

export function listenOnSocket(
    socketPath: string,
    onMessage: (msg: JsonMessage) => void,
    options?: { timeoutMs?: number; onClose?: () => void },
): Promise<UdsConnection> {
    return new Promise((resolve, reject) => {
        const dir = dirname(socketPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

        const receiver = createMessageReceiver(onMessage);

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

            const reader = new FrameReader(receiver);
            const onClose = options?.onClose;

            socket.on('data', (chunk) => reader.push(chunk));
            socket.on('close', () => onClose?.());

            resolve({
                send(msg: JsonMessage) {
                    sendMessage(socket, msg);
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
    const conn = await listenOnSocket(socketPath, onMessage as (msg: JsonMessage) => void, options);
    return {
        close() {
            conn.close();
        },
    };
}
