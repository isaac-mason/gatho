// browser test helpers — starts a gatho room server and a tiny HTTP server
// that serves a page with the client bundle for playwright to load.

import { readFileSync } from 'fs';
import { createServer as createHttpServer } from 'http';
import { resolve } from 'path';
import type { Room } from '../../src/room';
import { auth, start } from '../../src/room';
import type { StartOptions } from '../../src/room/start';

const CLIENT_BUNDLE_PATH = resolve(import.meta.dirname, '../../dist/client.js');

// read the built client bundle — inlined into the served HTML page
function readClientBundle(): string {
    return readFileSync(CLIENT_BUNDLE_PATH, 'utf-8');
}

// minimal HTML page that loads the gatho client and exposes it on window
function buildPage(clientBundle: string): string {
    return `<!DOCTYPE html>
<html>
<head><title>gatho browser test</title></head>
<body>
<script type="module">
${clientBundle}

// expose connect on window so playwright can call it
window.__gatho = { connect };
</script>
</body>
</html>`;
}

// start a tiny HTTP server that serves the test page
export function startPageServer(): Promise<{ port: number; close: () => void }> {
    const clientBundle = readClientBundle();
    const html = buildPage(clientBundle);

    return new Promise((resolve, reject) => {
        const server = createHttpServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        });

        server.listen(0, () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('failed to get page server address'));
                return;
            }
            resolve({
                port: addr.port,
                close: () => server.close(),
            });
        });

        server.on('error', reject);
    });
}

// start a gatho room with configurable callbacks.
// returns the room handle and the ws port.
// port is required — start() doesn't expose the os-assigned port on the
// room handle, so callers must pick an explicit port for each test.
export async function startRoom<ClientData = Record<string, unknown>>(
    opts: Partial<
        Pick<
            StartOptions<ClientData>,
            'onDrop' | 'onReconnect' | 'onLeave' | 'onJoin' | 'onMessage' | 'onShutdown' | 'maxBufferBytes'
        >
    > & {
        port: number;
        onAuth?: StartOptions<ClientData>['onAuth'];
    },
): Promise<{ room: Room<ClientData>; wsPort: number }> {
    const room = await start<ClientData>({
        port: opts.port,
        onAuth: opts.onAuth ?? (() => auth.ok({} as ClientData)),
        onJoin: opts.onJoin,
        onMessage: opts.onMessage,
        onLeave: opts.onLeave,
        onDrop: opts.onDrop,
        onReconnect: opts.onReconnect,
        onShutdown: opts.onShutdown,
        maxBufferBytes: opts.maxBufferBytes,
    });

    return { room: room as Room<ClientData>, wsPort: opts.port };
}
