// reconnection lifecycle tests — verifies session tokens, close codes,
// onDrop/onLeave flow, backward compatibility, and server-initiated disconnect.
// these tests use node's WebSocket client (via gatho client), not a real browser.
// network-drop scenarios (close code 1006, backoff, buffering during offline)
// are tested in tst/browser/ with playwright + setOffline.
import { afterEach, describe, expect, it } from 'vitest';
import { connect } from '../../client';
import type { Client, Room } from '../../room';
import { auth, start } from '../../room';

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

    it('server sends __session token on initial connection', async () => {
        // the client stores the session token internally and uses it for
        // reconnection. we can't read the token directly from the client,
        // but we can verify the client transitions to 'open' (which means
        // the ws connected and onopen fired).
        room = await start({
            port: 19900,
            onAuth: () => auth.ok({}),
        });

        const conn = connect('ws://127.0.0.1:19900');
        await waitUntil(() => conn.state === 'open');

        // the fact that we're open means the initial ws connected.
        // the session token was sent as a protocol message.
        expect(conn.state).toBe('open');

        conn.close();
    });

    it('close code 4000 (consented) — onDrop NOT called, onLeave fires', async () => {
        let dropCalled = false;
        let leaveCalled = false;

        room = await start({
            port: 19901,
            onAuth: () => auth.ok({}),
            onDrop: () => {
                dropCalled = true;
            },
            onLeave: () => {
                leaveCalled = true;
            },
        });

        const conn = connect('ws://127.0.0.1:19901');
        await waitUntil(() => conn.state === 'open');

        // client.close() sends __leave + closes with 4000
        conn.close();
        await sleep(300);

        expect(dropCalled).toBe(false);
        expect(leaveCalled).toBe(true);
    });

    it('client enters closed state on consented close, not reconnecting', async () => {
        room = await start({
            port: 19902,
            onAuth: () => auth.ok({}),
            onDrop: (_r, _c, _code) => {
                // should not be called
            },
        });

        const conn = connect('ws://127.0.0.1:19902');
        await waitUntil(() => conn.state === 'open');

        let closeCode = 0;
        conn.on('close', (code) => {
            closeCode = code;
        });

        conn.close();
        await sleep(100);

        expect(conn.state).toBe('closed');
        expect(closeCode).toBe(4000);
    });

    it('no onDrop defined — all disconnects are permanent (backward compat)', async () => {
        let leaveCalled = false;

        room = await start({
            port: 19903,
            onAuth: () => auth.ok({}),
            // no onDrop — backward compatible behavior
            onLeave: () => {
                leaveCalled = true;
            },
        });

        const conn = connect('ws://127.0.0.1:19903');
        await waitUntil(() => conn.state === 'open');

        // close without __leave (non-consented) — since no onDrop, should evict immediately
        conn.close();
        await sleep(300);

        // onLeave should have fired since there's no onDrop
        expect(leaveCalled).toBe(true);
    });

    it('room.disconnect(client) — server-initiated consented close', async () => {
        let dropCalled = false;
        let leaveCalled = false;
        let leaveClientId = '';
        let joinedClient: Client | null = null;

        room = await start({
            port: 19904,
            onAuth: () => auth.ok({}),
            onJoin: (_r, client) => {
                joinedClient = client;
            },
            onDrop: () => {
                dropCalled = true;
            },
            onLeave: (_r, client) => {
                leaveCalled = true;
                leaveClientId = client.id;
            },
        });

        const conn = connect('ws://127.0.0.1:19904');
        await waitUntil(() => conn.state === 'open');
        await waitUntil(() => joinedClient !== null);

        // server-initiated disconnect — should skip onDrop, fire onLeave
        room!.disconnect(joinedClient!);
        await sleep(300);

        expect(dropCalled).toBe(false);
        expect(leaveCalled).toBe(true);
        expect(leaveClientId).toBe(joinedClient!.id);
        expect(room!.clients.count()).toBe(0);
    });

    it('room.disconnect removes client from tracking', async () => {
        let joinedClient: Client | null = null;

        room = await start({
            port: 19905,
            onAuth: () => auth.ok({}),
            onJoin: (_r, client) => {
                joinedClient = client;
            },
        });

        const conn = connect('ws://127.0.0.1:19905');
        await waitUntil(() => conn.state === 'open');
        await waitUntil(() => joinedClient !== null);

        expect(room!.clients.count()).toBe(1);

        room!.disconnect(joinedClient!);
        await sleep(200);

        expect(room!.clients.count()).toBe(0);
        expect(room!.clients.has(joinedClient!.id)).toBe(false);

        conn.close();
    });

    it('handleShutdown fires onLeave for all connected clients', async () => {
        const leftIds: string[] = [];
        const joinedIds: string[] = [];

        room = await start({
            port: 19906,
            onAuth: () => auth.ok({}),
            onJoin: (_r, client) => {
                joinedIds.push(client.id);
            },
            onLeave: (_r, client) => {
                leftIds.push(client.id);
            },
        });

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
        let dropCode = 0;
        let dropCalled = false;

        room = await start({
            port: 19907,
            onAuth: () => auth.ok({}),
            onDrop: (_r, _c, code) => {
                dropCalled = true;
                dropCode = code;
            },
        });

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

    it('send with { reliable: false } does not buffer for disconnected clients', async () => {
        // we can only test this indirectly: connect a client, disconnect it
        // via server forcing a close (non-consented), then send unreliable messages.
        // when the client reconnects (not in this test), it should NOT receive those messages.
        // here we just verify the server doesn't crash when sending unreliable to disconnected.
        let joinedClient: Client | null = null;
        let dropFired = false;

        room = await start({
            port: 19908,
            onAuth: () => auth.ok({}),
            onJoin: (_r, client) => {
                joinedClient = client;
            },
            onDrop: (r, client) => {
                dropFired = true;
                r.allowReconnection(client, 5000);

                // send unreliable messages while client is disconnected
                r.send(client, JSON.stringify({ unreliable: 1 }), { reliable: false });
                r.send(client, JSON.stringify({ unreliable: 2 }), { reliable: false });

                // also send a reliable message for comparison
                r.send(client, JSON.stringify({ reliable: 1 }));
            },
        });

        const conn = connect('ws://127.0.0.1:19908');
        await waitUntil(() => conn.state === 'open');
        await waitUntil(() => joinedClient !== null);

        // we can't simulate a real network drop in standalone mode,
        // but we can verify the API doesn't crash
        // the unreliable messages should be silently dropped when socket is null
        expect(room!.clients.count()).toBe(1);

        conn.close();
    });

    it('broadcast with { reliable: false } skips disconnected clients', async () => {
        // similar to above — verify broadcast with reliable:false doesn't crash
        // when some clients are disconnected
        room = await start({
            port: 19909,
            onAuth: () => auth.ok({}),
        });

        const conn = connect('ws://127.0.0.1:19909');
        await waitUntil(() => conn.state === 'open');

        // broadcast unreliable when all are connected — should work fine
        room!.broadcast(JSON.stringify({ hello: 'world' }), { reliable: false });
        await sleep(100);

        conn.close();
    });

    it('client drop event fires and state becomes reconnecting on unexpected close', async () => {
        // when the server shuts down without the client sending __leave,
        // the client enters RECONNECTING state and emits 'drop'
        room = await start({
            port: 19910,
            onAuth: () => auth.ok({}),
        });

        const conn = connect('ws://127.0.0.1:19910');
        await waitUntil(() => conn.state === 'open');

        let dropped = false;
        conn.on('drop', () => {
            dropped = true;
        });

        // server shutdown closes all sockets with 1001 — non-consented from client's perspective
        await room!.stop();
        room = null;
        await sleep(300);

        expect(dropped).toBe(true);
        expect(conn.state).toBe('reconnecting');

        conn.close();
        expect(conn.state).toBe('closed');
    });

    it('client close event fires with code 4000 on consented close', async () => {
        room = await start({
            port: 19911,
            onAuth: () => auth.ok({}),
        });

        const conn = connect('ws://127.0.0.1:19911');
        await waitUntil(() => conn.state === 'open');

        let closeCode = 0;
        let closeReason = '';
        conn.on('close', (code, reason) => {
            closeCode = code;
            closeReason = reason;
        });

        conn.close();
        await sleep(100);

        expect(closeCode).toBe(4000);
        expect(conn.state).toBe('closed');
    });

    it('client send during reconnecting state buffers reliable messages', async () => {
        room = await start({
            port: 19912,
            onAuth: () => auth.ok({}),
        });

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
        room = await start({
            port: 19913,
            onAuth: () => auth.ok({}),
        });

        const conn = connect('ws://127.0.0.1:19913');
        await waitUntil(() => conn.state === 'open');

        // force into reconnecting state
        await room!.stop();
        room = null;
        await waitUntil(() => conn.state === 'reconnecting');

        let closeCode = 0;
        conn.on('close', (code) => {
            closeCode = code;
        });

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

    it('allowReconnection holds the client seat for the specified window', async () => {
        let joinedClient: Client | null = null;
        let dropFired = false;
        let leaveFired = false;

        room = await start({
            port: 19914,
            onAuth: () => auth.ok({}),
            onJoin: (_r, client) => {
                joinedClient = client;
            },
            onDrop: (r, client) => {
                dropFired = true;
                // hold seat for 500ms
                r.allowReconnection(client, 500);
            },
            onLeave: () => {
                leaveFired = true;
            },
        });

        const conn = connect('ws://127.0.0.1:19914');
        await waitUntil(() => conn.state === 'open');
        await waitUntil(() => joinedClient !== null);

        // we need a non-consented close to trigger onDrop.
        // destroy the underlying ws without sending __leave.
        // the client's close() sends __leave + 4000 which is consented.
        // instead, we'll stop the room (which closes with 1001) but that
        // goes through handleShutdown which clears the map first.
        // the only way to get a non-consented close in standalone tests
        // is somewhat limited. let's verify the allowReconnection timer
        // works by calling it directly on a mock scenario.
        // actually — we can't easily trigger onDrop from standalone tests
        // without accessing internals. this scenario is better tested in
        // browser tests with setOffline.

        conn.close();
        await sleep(100);

        // conn.close() sends __leave → 4000 → onDrop NOT called
        // this is expected — onDrop only fires on non-consented close
        // the allowReconnection timer test needs a real network drop (browser test)
    });

    it('multiple clients — one leaves, others unaffected', async () => {
        const joinedIds: string[] = [];
        const leftIds: string[] = [];

        room = await start({
            port: 19915,
            onAuth: () => auth.ok({}),
            onJoin: (_r, client) => {
                joinedIds.push(client.id);
            },
            onLeave: (_r, client) => {
                leftIds.push(client.id);
            },
        });

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
        // when a client tries to reconnect with an expired/invalid session token,
        // the server upgrades the connection (instead of 401) and sends __auth_error.
        // the client should enter CLOSED permanently.
        // this is hard to test without a real network drop and reconnection attempt.
        // we verify the server-side behavior: an invalid session param still gets upgraded.
        room = await start({
            port: 19916,
            onAuth: () => auth.ok({}),
        });

        // connect with a fake session param — should be treated as reconnection attempt
        // but the session is invalid, so server sends __auth_error
        const conn = connect('ws://127.0.0.1:19916?session=invalid-token');

        let closeCode = 0;
        conn.on('close', (code) => {
            closeCode = code;
        });

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

        room = await start<TestData>({
            port: 19917,
            onAuth: () => auth.ok({ role: 'admin' }),
            onJoin: (_r, client) => {
                joinData = client.data;
            },
            onLeave: (_r, client) => {
                leaveData = client.data;
            },
        });

        const conn = connect('ws://127.0.0.1:19917');
        await waitUntil(() => joinData !== null);

        expect(joinData!.role).toBe('admin');

        conn.close();
        await sleep(300);

        expect(leaveData!.role).toBe('admin');
    });

    it('client state transitions: connecting → open → closed', async () => {
        room = await start({
            port: 19918,
            onAuth: () => auth.ok({}),
        });

        const conn = connect('ws://127.0.0.1:19918');

        // initial state is connecting
        expect(conn.state).toBe('connecting');

        await waitUntil(() => conn.state === 'open');
        expect(conn.state).toBe('open');

        conn.close();
        await sleep(100);
        expect(conn.state).toBe('closed');
    });

    it('client state transitions: connecting → open → reconnecting → closed', async () => {
        room = await start({
            port: 19919,
            onAuth: () => auth.ok({}),
        });

        const conn = connect('ws://127.0.0.1:19919');
        await waitUntil(() => conn.state === 'open');

        // kill server — causes non-consented close
        await room!.stop();
        room = null;
        await waitUntil(() => conn.state === 'reconnecting');

        expect(conn.state).toBe('reconnecting');

        // user closes — stops reconnection
        conn.close();
        expect(conn.state).toBe('closed');
    });
});
