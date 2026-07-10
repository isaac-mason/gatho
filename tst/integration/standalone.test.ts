import { connect } from 'gatho/client';
import type { Room } from 'gatho/room';
import { auth, create } from 'gatho/room';
import { afterEach, describe, expect, it } from 'vitest';

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// collect messages from a connection, with a helper to wait for N messages.
function collectMessages(url: string) {
    const messages: unknown[] = [];
    const conn = connect(url, {
        onMessage: (msg) => messages.push(msg),
    });

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
        room = create({
            standalone: true,
            onAuth: () => auth.ok({}),
        });
        await room.start();

        // roomId should be a uuid (auto-generated)
        expect(room.roomId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        // roomType defaults to 'room'
        expect(room.roomType).toBe('room');
        // standalone mode — no server
        expect(room.serverId).toBeUndefined();
    });

    it('accepts connections without jwt tokens (dev mode)', async () => {
        room = create({
            standalone: true,
            port: 19876,
            onAuth: () => auth.ok({}),
            onMessage: (client, msg) => client.send(msg),
        });
        await room.start();

        const { conn, waitFor } = collectMessages('ws://127.0.0.1:19876');
        await sleep(200);

        conn.send(JSON.stringify({ ping: true }));
        const msgs = await waitFor(1);
        expect(msgs[0]).toBe(JSON.stringify({ ping: true }));

        conn.close();
    });

    it('echo round-trip — send message, receive same message back', async () => {
        room = create({
            standalone: true,
            port: 19877,
            onAuth: () => auth.ok({}),
            onMessage: (client, msg) => client.send(msg),
        });
        await room.start();

        const { conn, waitFor } = collectMessages('ws://127.0.0.1:19877');
        await sleep(200);

        conn.send(JSON.stringify({ hello: 'world' }));
        conn.send(JSON.stringify({ count: 42 }));

        const msgs = await waitFor(2);
        expect(msgs[0]).toBe(JSON.stringify({ hello: 'world' }));
        expect(msgs[1]).toBe(JSON.stringify({ count: 42 }));

        conn.close();
    });

    it('broadcast reaches all connected clients', async () => {
        room = create({
            standalone: true,
            port: 19878,
            onAuth: () => auth.ok({}),
            onMessage: (_client, msg) => room!.broadcast(msg),
        });
        await room.start();

        const c1 = collectMessages('ws://127.0.0.1:19878');
        const c2 = collectMessages('ws://127.0.0.1:19878');
        await sleep(300);

        // send from c1, both should receive
        c1.conn.send(JSON.stringify({ from: 'c1' }));

        const [m1] = await c1.waitFor(1);
        const [m2] = await c2.waitFor(1);

        expect(m1).toBe(JSON.stringify({ from: 'c1' }));
        expect(m2).toBe(JSON.stringify({ from: 'c1' }));

        c1.conn.close();
        c2.conn.close();
    });

    it('client tracking — join, count, leave', async () => {
        let joinedCount = 0;
        let leftCount = 0;

        room = create({
            standalone: true,
            port: 19879,
            onAuth: () => auth.ok({}),
            onJoin: () => {
                joinedCount++;
                // send current client count to all
                room!.broadcast(JSON.stringify({ clients: room!.clients.count() }));
            },
            onLeave: () => {
                leftCount++;
                room!.broadcast(JSON.stringify({ clients: room!.clients.count() }));
            },
        });
        await room.start();

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
        expect(c1Msgs[0]).toBe(JSON.stringify({ clients: 1 }));
        expect(c1Msgs[1]).toBe(JSON.stringify({ clients: 2 }));

        // disconnect c2
        c2.conn.close();
        await sleep(300);

        expect(leftCount).toBe(1);
        expect(room.clients.count()).toBe(1);

        c1.conn.close();
    });

    it('onAuth rejection closes the connection', async () => {
        room = create({
            standalone: true,
            port: 19880,
            onAuth: () => auth.fail('not allowed'),
        });
        await room.start();

        let authError: unknown = null;
        let closed = false;
        connect('ws://127.0.0.1:19880', {
            onAuthError: (err) => {
                authError = err;
            },
            onClose: () => {
                closed = true;
            },
        });

        await sleep(500);

        expect(authError).toBe('not allowed');
        expect(closed).toBe(true);

        // no clients should be tracked
        expect(room.clients.count()).toBe(0);
    });

    it('room.stop() closes all connections gracefully', async () => {
        room = create({
            standalone: true,
            port: 19881,
            onAuth: () => auth.ok({}),
        });
        await room.start();

        let dropped = false;
        let closeCode = 0;
        const conn = connect('ws://127.0.0.1:19881', {
            onDrop: () => {
                dropped = true;
            },
            onClose: ({ code }) => {
                closeCode = code;
            },
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
        conn.close();
        expect(closeCode).toBe(4000);
        expect(conn.state).toBe('closed');
    });

    it('server config fields are reflected on room handle', async () => {
        room = create({
            server: {
                roomId: 'custom-id',
                roomType: 'custom-type',
                serverId: 'srv-1',
                roomSecret: 'test',
            },
            onAuth: () => auth.ok({}),
        });
        await room.start();

        expect(room.roomId).toBe('custom-id');
        expect(room.roomType).toBe('custom-type');
        expect(room.serverId).toBe('srv-1');
    });

    it('the single onMessage handler receives every message', async () => {
        room = create({
            standalone: true,
            port: 19882,
            onAuth: () => auth.ok({}),
            onMessage: (client, msg) => client.send(msg),
        });
        await room.start();

        const a: unknown[] = [];
        const conn = connect('ws://127.0.0.1:19882', {
            onMessage: (msg) => a.push(msg),
        });

        await sleep(200);
        conn.send(JSON.stringify({ x: 1 }));
        conn.send(JSON.stringify({ x: 2 }));
        await sleep(200);

        // the single handler received both messages in order.
        expect(a).toEqual([JSON.stringify({ x: 1 }), JSON.stringify({ x: 2 })]);

        conn.close();
    });
});
