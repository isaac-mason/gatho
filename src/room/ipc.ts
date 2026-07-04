// room-side notify link (node runtimes): dial the parent server's notify
// channel over uds or tcp. rooms only ever send to the server — they never
// receive. so no frame reading is needed; we just wire up the send side.
//
// non-node runtimes don't use this module — they construct a Notifier from
// whatever pipe their host provides (e.g. a workerd service binding) or use
// the frame helpers in common/notify-protocol directly.

import type { Socket } from 'node:net';
import { encodeNotifyFrame, encodeRawFrame, type Notifier, type NotifyMessage } from '../common/notify-protocol';

// node:net is imported dynamically inside dial() — this module's top level is
// runtime-neutral, so bundling `gatho/room` for a non-node runtime (workerd)
// only touches node:net if a uri target is actually dialed. rooms hosted with
// a Notifier object never hit it.

/** parsed form of a GATHO_NOTIFY_SOCKET uri */
export type NotifyTarget = { kind: 'uds'; path: string } | { kind: 'tcp'; host: string; port: number; token: string };

/** parse a notify target: `uds:<path>`, `tcp://host:port?token=...`, or a bare
 *  filesystem path (treated as a uds socket path). */
export function parseNotifyTarget(uri: string): NotifyTarget {
    if (uri.startsWith('uds:')) {
        return { kind: 'uds', path: uri.slice('uds:'.length) };
    }
    if (uri.startsWith('tcp://')) {
        const url = new URL(uri);
        const port = Number(url.port);
        if (!Number.isInteger(port) || port <= 0) {
            throw new Error(`notify: invalid tcp port in ${JSON.stringify(uri)}`);
        }
        return {
            kind: 'tcp',
            host: url.hostname,
            port,
            token: url.searchParams.get('token') ?? '',
        };
    }
    if (uri.includes('://')) {
        throw new Error(`notify: unsupported uri scheme in ${JSON.stringify(uri)} (expected uds: or tcp://)`);
    }
    // schemeless — a plain socket path
    return { kind: 'uds', path: uri };
}

/** dial a parsed notify target */
export async function connectNotify(
    target: NotifyTarget,
    options?: { retries?: number; retryDelayMs?: number; onClose?: () => void },
): Promise<Notifier> {
    const { createConnection } = await import('node:net');
    if (target.kind === 'uds') {
        return dial(() => createConnection({ path: target.path }), `uds ${target.path}`, null, options);
    }
    return dial(
        () => createConnection({ host: target.host, port: target.port }),
        `tcp ${target.host}:${target.port}`,
        target.token,
        options,
    );
}

// shared dial-with-retry. for tcp, the auth token is written as the first
// frame immediately on connect — the server drops the connection if it's
// missing or wrong.
function dial(
    connect: () => Socket,
    label: string,
    token: string | null,
    options?: { retries?: number; retryDelayMs?: number; onClose?: () => void },
): Promise<Notifier> {
    const maxRetries = options?.retries ?? 50;
    const retryDelay = options?.retryDelayMs ?? 20;

    return new Promise((resolve, reject) => {
        let attempt = 0;

        const tryConnect = () => {
            const socket = connect();
            let connected = false;

            socket.on('connect', () => {
                connected = true;

                if (token !== null) {
                    socket.write(encodeRawFrame(new TextEncoder().encode(token)));
                }

                if (options?.onClose) {
                    socket.on('close', options.onClose);
                }

                resolve({
                    send(msg: NotifyMessage) {
                        socket.write(encodeNotifyFrame(msg));
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
                    reject(new Error(`notify: failed to connect to ${label} after ${maxRetries} attempts: ${error.message}`));
                    return;
                }
                setTimeout(tryConnect, retryDelay);
            });
        };

        tryConnect();
    });
}
