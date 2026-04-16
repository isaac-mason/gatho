// room-side ipc: connect to the parent server's uds socket.
// rooms only ever send to the server — they never receive.
// so no frame reading is needed; we just wire up the send side.

import { createConnection } from 'node:net';
import { sendMessage, type RoomMessage, type UdsConnection } from '../common/uds';

export function connectToSocket(
    socketPath: string,
    options?: { retries?: number; retryDelayMs?: number; onClose?: () => void },
): Promise<UdsConnection> {
    const maxRetries = options?.retries ?? 50;
    const retryDelay = options?.retryDelayMs ?? 20;

    return new Promise((resolve, reject) => {
        let attempt = 0;

        const tryConnect = () => {
            const socket = createConnection({ path: socketPath });
            let connected = false;

            socket.on('connect', () => {
                connected = true;

                if (options?.onClose) {
                    socket.on('close', options.onClose);
                }

                resolve({
                    send(msg: RoomMessage) {
                        sendMessage(socket, msg);
                    },
                    close() {
                        socket.destroy();
                    },
                });
            });

            socket.on('error', (error) => {
                if (connected) return;
                socket.destroy();
                attempt++;
                if (attempt >= maxRetries) {
                    reject(new Error(`uds: failed to connect to ${socketPath} after ${maxRetries} attempts: ${error.message}`));
                    return;
                }
                setTimeout(tryConnect, retryDelay);
            });
        };

        tryConnect();
    });
}
