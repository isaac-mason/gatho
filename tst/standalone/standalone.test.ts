import { afterEach, describe, expect, it } from 'vitest';
import { connect } from '../../client';
import type { Room } from '../../room';
import { auth, start } from '../../room';

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// collect messages from a connection, with a helper to wait for N messages.
function collectMessages(url: string) {
    const conn = connect(url);
    const messages: unknown[] = [];
    conn.on('message', (msg) => messages.push(msg));

    async function waitFor(n: number, timeoutMs = 3000): Promise<unknown[]> {
        const t0 = Date.now();
        while (messages.length < n) {
            if (Date.now() - t0 > timeoutMs) {
                throw new Error(`expected ${n} messages but got ${messages.length} after ${timeoutMs}ms`);
            }
            await sleep(50);
        }
        return messages.slice(0, n);
    }

    return { conn, messages, waitFor };
}

describe('standalone room', () => {
    let room: Room | null = null;

    afterEach(async () => {
        if (room) {
            await room.stop();
            room = null;
        }
    });

    it('starts with auto-generated roomId and default roomType', async () => {
        room = await start({
            onAuth: () => auth.ok({}),
        });

        // roomId should be a uuid (auto-generated)
        expect(room.roomId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        // roomType defaults to 'room'
        expect(room.roomType).toBe('room');
        // standalone mode — no server
        expect(room.serverId).toBeUndefined();
    });

    it('accepts connections without jwt tokens (dev mode)', async () => {
        room = await start({
            port: 19876,
            onAuth: () => auth.ok({}),
            onMessage: (r, client, msg) => r.send(client, msg),
        });

        const { conn, waitFor } = collectMessages('ws://127.0.0.1:19876');
        await sleep(200);

        conn.send({ ping: true });
        const msgs = await waitFor(1);
        expect(msgs[0]).toEqual({ ping: true });

        conn.close();
    });

    it('echo round-trip — send message, receive same message back', async () => {
        room = await start({
            port: 19877,
            onAuth: () => auth.ok({}),
            onMessage: (r, client, msg) => r.send(client, msg),
        });

        const { conn, waitFor } = collectMessages('ws://127.0.0.1:19877');
        await sleep(200);

        conn.send({ hello: 'world' });
        conn.send({ count: 42 });

        const msgs = await waitFor(2);
        expect(msgs[0]).toEqual({ hello: 'world' });
        expect(msgs[1]).toEqual({ count: 42 });

        conn.close();
    });

    it('broadcast reaches all connected clients', async () => {
        room = await start({
            port: 19878,
            onAuth: () => auth.ok({}),
            onMessage: (r, _client, msg) => r.broadcast(msg),
        });

        const c1 = collectMessages('ws://127.0.0.1:19878');
        const c2 = collectMessages('ws://127.0.0.1:19878');
        await sleep(300);

        // send from c1, both should receive
        c1.conn.send({ from: 'c1' });

        const [m1] = await c1.waitFor(1);
        const [m2] = await c2.waitFor(1);

        expect(m1).toEqual({ from: 'c1' });
        expect(m2).toEqual({ from: 'c1' });

        c1.conn.close();
        c2.conn.close();
    });

    it('client tracking — join, count, leave', async () => {
        let joinedCount = 0;
        let leftCount = 0;

        room = await start({
            port: 19879,
            onAuth: () => auth.ok({}),
            onJoin: (r) => {
                joinedCount++;
                // send current client count to all
                r.broadcast({ clients: r.clients.count() });
            },
            onLeave: (r) => {
                leftCount++;
                r.broadcast({ clients: r.clients.count() });
            },
        });

        const c1 = collectMessages('ws://127.0.0.1:19879');
        await sleep(300);

        expect(joinedCount).toBe(1);
        expect(room.clients.count()).toBe(1);

        const c2 = collectMessages('ws://127.0.0.1:19879');
        await sleep(300);

        expect(joinedCount).toBe(2);
        expect(room.clients.count()).toBe(2);

        // c1 should have received join notifications
        // first: { clients: 1 } (when c1 joined)
        // second: { clients: 2 } (when c2 joined)
        const c1Msgs = await c1.waitFor(2);
        expect(c1Msgs[0]).toEqual({ clients: 1 });
        expect(c1Msgs[1]).toEqual({ clients: 2 });

        // disconnect c2
        c2.conn.close();
        await sleep(300);

        expect(leftCount).toBe(1);
        expect(room.clients.count()).toBe(1);

        c1.conn.close();
    });

    it('onAuth rejection closes the connection', async () => {
        room = await start({
            port: 19880,
            onAuth: () => auth.fail('not allowed'),
        });

        const conn = connect('ws://127.0.0.1:19880');

        let authError: unknown = null;
        conn.on('authError', (err) => {
            authError = err;
        });

        let closed = false;
        conn.on('close', () => {
            closed = true;
        });

        await sleep(500);

        expect(authError).toBe('not allowed');
        expect(closed).toBe(true);

        // no clients should be tracked
        expect(room.clients.count()).toBe(0);
    });

    it('room.stop() closes all connections gracefully', async () => {
        room = await start({
            port: 19881,
            onAuth: () => auth.ok({}),
        });

        const conn = connect('ws://127.0.0.1:19881');
        let dropped = false;
        conn.on('drop', () => {
            dropped = true;
        });
        await sleep(300);

        expect(room.clients.count()).toBe(1);

        await room.stop();
        room = null;
        await sleep(200);

        // client enters RECONNECTING on non-consented server close —
        // it doesn't know the server is gone permanently
        expect(dropped).toBe(true);
        expect(conn.state).toBe('reconnecting');

        // clean up — stop the reconnection loop
        let closeCode = 0;
        conn.on('close', (code) => {
            closeCode = code;
        });
        conn.close();
        expect(closeCode).toBe(4000);
        expect(conn.state).toBe('closed');
    });

    it('server config fields are reflected on room handle', async () => {
        room = await start({
            server: {
                roomId: 'custom-id',
                roomType: 'custom-type',
                serverId: 'srv-1',
            },
            onAuth: () => auth.ok({}),
        });

        expect(room.roomId).toBe('custom-id');
        expect(room.roomType).toBe('custom-type');
        expect(room.serverId).toBe('srv-1');
    });

    it('multiple listeners fire for the same event', async () => {
        room = await start({
            port: 19882,
            onAuth: () => auth.ok({}),
            onMessage: (r, client, msg) => r.send(client, msg),
        });

        const conn = connect('ws://127.0.0.1:19882');
        const a: unknown[] = [];
        const b: unknown[] = [];

        conn.on('message', (msg) => a.push(msg));
        conn.on('message', (msg) => b.push(msg));

        await sleep(200);
        conn.send({ x: 1 });
        await sleep(200);

        // both listeners should have received the message
        expect(a).toEqual([{ x: 1 }]);
        expect(b).toEqual([{ x: 1 }]);

        conn.close();
    });

    it('on() returns an unsubscribe function that removes the listener', async () => {
        room = await start({
            port: 19883,
            onAuth: () => auth.ok({}),
            onMessage: (r, client, msg) => r.send(client, msg),
        });

        const conn = connect('ws://127.0.0.1:19883');
        const a: unknown[] = [];
        const b: unknown[] = [];

        const unsub = conn.on('message', (msg) => a.push(msg));
        conn.on('message', (msg) => b.push(msg));

        await sleep(200);
        conn.send({ x: 1 });
        await sleep(200);

        // both received first message
        expect(a).toEqual([{ x: 1 }]);
        expect(b).toEqual([{ x: 1 }]);

        // unsubscribe first listener
        unsub();

        conn.send({ x: 2 });
        await sleep(200);

        // only b should have received the second message
        expect(a).toEqual([{ x: 1 }]);
        expect(b).toEqual([{ x: 1 }, { x: 2 }]);

        conn.close();
    });

    it('off() removes a listener by reference', async () => {
        room = await start({
            port: 19884,
            onAuth: () => auth.ok({}),
            onMessage: (r, client, msg) => r.send(client, msg),
        });

        const conn = connect('ws://127.0.0.1:19884');
        const a: unknown[] = [];

        const handler = (msg: unknown) => a.push(msg);
        conn.on('message', handler);

        await sleep(200);
        conn.send({ x: 1 });
        await sleep(200);

        expect(a).toEqual([{ x: 1 }]);

        conn.off('message', handler);

        conn.send({ x: 2 });
        await sleep(200);

        // should not have received the second message
        expect(a).toEqual([{ x: 1 }]);

        conn.close();
    });
});
