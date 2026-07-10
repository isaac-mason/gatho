// ws transport generation-guard tests. these drive the REAL ws transport (a real
// http+ws server on an os-assigned port) with real ws client connections, because
// the hazard being tested — a stale socket's close/message handlers firing after a
// newer socket replaced it in the transport's clientId->socket map — only exists in
// the transport's own bookkeeping, not in the room engine.

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientSocket, TransportHandlers, TransportServer } from '../../src/room/transport/types';
import { wsTransport } from '../../src/room/transport/ws';

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn: () => boolean, timeoutMs = 2000, interval = 10): Promise<void> {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > timeoutMs) throw new Error('waitUntil timed out');
        await sleep(interval);
    }
}

describe('ws transport socket identity', () => {
    let server: TransportServer | null = null;

    afterEach(() => {
        server?.close();
        server = null;
    });

    it('a stale socket close does not mute the live socket or fire the room-side close', async () => {
        // every upgrade maps to the same clientId. the second connection is flagged
        // as reconnecting, so completeUpgrade retires the first socket from
        // clientSockets — reproducing the replacement that makes the first socket stale.
        let connectCount = 0;
        const sockets: ClientSocket[] = [];
        const messages: string[] = [];
        let closeFired = 0;

        const handlers: TransportHandlers = {
            upgrade() {
                connectCount += 1;
                return { clientId: 'c1', reconnecting: connectCount > 1 };
            },
            open(_clientId, socket) {
                sockets.push(socket);
                socket.subscribe('room');
            },
            reconnect(_clientId, socket) {
                sockets.push(socket);
                socket.subscribe('room');
            },
            message(_clientId, data) {
                messages.push(new TextDecoder().decode(data));
            },
            close() {
                closeFired += 1;
            },
        };

        server = await wsTransport().listen(handlers, { port: 0 });
        const port = server.port;

        // first client connects (open).
        const first = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((res) => first.on('open', () => res()));
        await waitUntil(() => sockets.length === 1);

        // second client connects with the same clientId (reconnect) — this replaces
        // the first socket in the transport's clientSockets map.
        const second = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((res) => second.on('open', () => res()));
        await waitUntil(() => sockets.length === 2);

        // now close the first (now-stale) socket. its close handler must be inert:
        // it must NOT fire the room-side close, and must NOT remove the live socket's
        // mapping.
        first.close();
        await sleep(100);
        expect(closeFired).toBe(0);

        // the live (second) socket still works: a message it sends is still delivered.
        second.send(Buffer.from('still-alive'));
        await waitUntil(() => messages.includes('still-alive'));

        // a broadcast still reaches the live socket (its subscription survived the
        // stale close).
        const received: string[] = [];
        second.on('message', (data: Buffer) => received.push(data.toString()));
        server.publish('room', Buffer.from('bcast'), true);
        await waitUntil(() => received.includes('bcast'));

        // when the live socket finally closes, the room-side close fires exactly once.
        second.close();
        await waitUntil(() => closeFired === 1);
    });

    it('the normal single-socket close still fires the room-side close', async () => {
        let closeFired = 0;
        const handlers: TransportHandlers = {
            upgrade() {
                return { clientId: 'solo' };
            },
            open(_clientId, socket) {
                socket.subscribe('room');
            },
            reconnect() {},
            message() {},
            close() {
                closeFired += 1;
            },
        };

        server = await wsTransport().listen(handlers, { port: 0 });
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
        await new Promise<void>((res) => ws.on('open', () => res()));
        ws.close();
        await waitUntil(() => closeFired === 1);
        expect(closeFired).toBe(1);
    });
});
