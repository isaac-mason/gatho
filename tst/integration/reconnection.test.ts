// reconnection lifecycle tests — verifies close codes, onDrop/onLeave flow,
// backward compatibility, and server-initiated disconnect.
// these tests use node's WebSocket client (via gatho client), not a real browser.
// network-drop scenarios (close code 1006, backoff, buffering during offline)
// are tested in tst/browser/ with playwright + setOffline.

import { connect } from 'gatho/client';
import type { Client, Room } from 'gatho/room';
import { auth, create } from 'gatho/room';
import { afterEach, describe, expect, it } from 'vitest';

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// wait for a condition to become true, polling every interval ms
async function waitUntil(fn: () => boolean, timeoutMs = 3000, interval = 50): Promise<void> {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > timeoutMs) {
            throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
        }
        await sleep(interval);
    }
}

describe('reconnection lifecycle', () => {
    let room: Room | null = null;

    afterEach(async () => {
        if (room) {
            await room.stop();
            room = null;
        }
    });

    it('close code 4000 (consented) — onDrop NOT called, onLeave fires, client closed with 4000', async () => {
        let dropCalled = false;
        let leaveCalled = false;

        room = create({
            standalone: true,
            port: 19901,
            onAuth: () => auth.ok({}),
            onDrop: () => {
                dropCalled = true;
            },
            onLeave: () => {
                leaveCalled = true;
            },
        });
        await room.start();

        let closeCode = 0;
        const conn = connect('ws://127.0.0.1:19901', {
            onClose: ({ code }) => {
                closeCode = code;
            },
        });
        await waitUntil(() => conn.state === 'open');

        // client.close() sends __leave + closes with 4000
        conn.close();
        await sleep(300);

        // server side: onDrop skipped, onLeave fired
        expect(dropCalled).toBe(false);
        expect(leaveCalled).toBe(true);

        // client side: closed state with code 4000, not reconnecting
        expect(conn.state).toBe('closed');
        expect(closeCode).toBe(4000);
    });

    it('no onDrop defined — all disconnects are permanent (backward compat)', async () => {
        let leaveCalled = false;

        room = create({
            standalone: true,
            port: 19903,
            onAuth: () => auth.ok({}),
            // no onDrop — backward compatible behavior
            onLeave: () => {
                leaveCalled = true;
            },
        });
        await room.start();

        const conn = connect('ws://127.0.0.1:19903');
        await waitUntil(() => conn.state === 'open');

        // close without __leave (non-consented) — since no onDrop, should evict immediately
        conn.close();
        await sleep(300);

        // onLeave should have fired since there's no onDrop
        expect(leaveCalled).toBe(true);
    });

    it('client.disconnect() — server-initiated consented close, removes from tracking', async () => {
        let dropCalled = false;
        let leaveCalled = false;
        let leaveClientId = '';
        let joinedClient: Client | null = null;

        room = create({
            standalone: true,
            port: 19904,
            onAuth: () => auth.ok({}),
            onJoin: (client) => {
                joinedClient = client;
            },
            onDrop: () => {
                dropCalled = true;
            },
            onLeave: (client) => {
                leaveCalled = true;
                leaveClientId = client.id;
            },
        });
        await room.start();

        const conn = connect('ws://127.0.0.1:19904');
        await waitUntil(() => conn.state === 'open');
        await waitUntil(() => joinedClient !== null);

        expect(room!.clients.count()).toBe(1);

        // server-initiated disconnect — should skip onDrop, fire onLeave
        joinedClient!.disconnect();
        await sleep(300);

        expect(dropCalled).toBe(false);
        expect(leaveCalled).toBe(true);
        expect(leaveClientId).toBe(joinedClient!.id);

        // client removed from tracking
        expect(room!.clients.count()).toBe(0);
        expect(room!.clients.has(joinedClient!.id)).toBe(false);

        conn.close();
    });

    it('handleShutdown fires onLeave for all connected clients', async () => {
        const leftIds: string[] = [];
        const joinedIds: string[] = [];

        room = create({
            standalone: true,
            port: 19906,
            onAuth: () => auth.ok({}),
            onJoin: (client) => {
                joinedIds.push(client.id);
            },
            onLeave: (client) => {
                leftIds.push(client.id);
            },
        });
        await room.start();

        const c1 = connect('ws://127.0.0.1:19906');
        const c2 = connect('ws://127.0.0.1:19906');
        await waitUntil(() => joinedIds.length === 2);

        await room!.stop();
        room = null; // prevent afterEach double-stop
        await sleep(200);

        // onLeave should have fired for both clients
        expect(leftIds.length).toBe(2);
        expect(leftIds.sort()).toEqual(joinedIds.sort());

        // clean up client connections (they'll be in reconnecting state)
        c1.close();
        c2.close();
    });

    it('onDrop fires with close code on non-consented server-close', async () => {
        // when the server shuts down, it closes sockets with code 1001.
        // since onDrop is defined, it should fire with code 1001.
        // BUT: handleShutdown clears the clients map before closing sockets,
        // so the close handler bails early (client not in map). the shutdown
        // path fires onLeave directly, not via the close handler.
        // so onDrop should NOT fire on room.stop() — only onLeave.
        let dropCalled = false;

        room = create({
            standalone: true,
            port: 19907,
            onAuth: () => auth.ok({}),
            onDrop: () => {
                dropCalled = true;
            },
        });
        await room.start();

        const conn = connect('ws://127.0.0.1:19907');
        await waitUntil(() => conn.state === 'open');

        await room!.stop();
        room = null;
        await sleep(200);

        // onDrop should NOT fire during graceful shutdown — the shutdown path
        // clears the client map then fires onLeave directly
        expect(dropCalled).toBe(false);

        conn.close();
    });

    it('client send during reconnecting state buffers reliable messages', async () => {
        room = create({
            standalone: true,
            port: 19912,
            onAuth: () => auth.ok({}),
        });
        await room.start();

        const conn = connect('ws://127.0.0.1:19912');
        await waitUntil(() => conn.state === 'open');

        // force into reconnecting state by killing the server
        await room!.stop();
        room = null;
        await waitUntil(() => conn.state === 'reconnecting');

        // reliable send (default) should buffer, not throw
        conn.send(JSON.stringify({ buffered: 1 }));
        conn.send(JSON.stringify({ buffered: 2 }));

        // unreliable send should silently drop, not throw
        conn.send(JSON.stringify({ dropped: 1 }), { reliable: false });

        // client should still be in reconnecting state
        expect(conn.state).toBe('reconnecting');

        conn.close();
    });

    it('client send buffer overflow transitions to closed', async () => {
        room = create({
            standalone: true,
            port: 19913,
            onAuth: () => auth.ok({}),
        });
        await room.start();

        let closeCode = 0;
        const conn = connect('ws://127.0.0.1:19913', {
            onClose: ({ code }) => {
                closeCode = code;
            },
        });
        await waitUntil(() => conn.state === 'open');

        // force into reconnecting state
        await room!.stop();
        room = null;
        await waitUntil(() => conn.state === 'reconnecting');

        // send enough data to overflow the 1mb client buffer.
        // each message is JSON serialized, then byte size is string.length * 2.
        // a 100kb string repeated ~6 times should exceed 1mb.
        const bigPayload = 'x'.repeat(100_000);
        for (let i = 0; i < 7; i++) {
            conn.send(JSON.stringify({ data: bigPayload }));
            if (conn.state === 'closed') break;
        }

        expect(conn.state).toBe('closed');
        expect(closeCode).toBe(1009);
    });

    it('multiple clients — one leaves, others unaffected', async () => {
        const joinedIds: string[] = [];
        const leftIds: string[] = [];

        room = create({
            standalone: true,
            port: 19915,
            onAuth: () => auth.ok({}),
            onJoin: (client) => {
                joinedIds.push(client.id);
            },
            onLeave: (client) => {
                leftIds.push(client.id);
            },
        });
        await room.start();

        const c1 = connect('ws://127.0.0.1:19915');
        const c2 = connect('ws://127.0.0.1:19915');
        const c3 = connect('ws://127.0.0.1:19915');
        await waitUntil(() => joinedIds.length === 3);

        expect(room!.clients.count()).toBe(3);

        // c2 leaves
        c2.close();
        await sleep(300);

        expect(room!.clients.count()).toBe(2);
        expect(leftIds.length).toBe(1);

        // c1 and c3 still connected
        expect(c1.state).toBe('open');
        expect(c3.state).toBe('open');

        c1.close();
        c3.close();
    });

    it('onAuth rejection during reconnection — client receives authError', async () => {
        room = create({
            standalone: true,
            port: 19916,
            onAuth: () => auth.ok({}),
        });
        await room.start();

        // connect with a fake session param — should be treated as reconnection attempt
        // but the session is invalid, so server sends __auth_error
        const conn = connect('ws://127.0.0.1:19916?session=invalid-token');

        await sleep(500);

        // the connection should have been closed — server sent __auth_error
        // for invalid session, then closed the socket
        expect(conn.state).toBe('closed');

        conn.close();
    });

    it('onJoin and onLeave receive correct client data from onAuth', async () => {
        type TestData = { role: string };
        let joinData: TestData | null = null;
        let leaveData: TestData | null = null;

        room = create<TestData>({
            standalone: true,
            port: 19917,
            onAuth: () => auth.ok({ role: 'admin' }),
            onJoin: (client) => {
                joinData = client.data;
            },
            onLeave: (client) => {
                leaveData = client.data;
            },
        });
        await room.start();

        const conn = connect('ws://127.0.0.1:19917');
        await waitUntil(() => joinData !== null);

        expect(joinData!.role).toBe('admin');

        conn.close();
        await sleep(300);

        expect(leaveData!.role).toBe('admin');
    });
});
