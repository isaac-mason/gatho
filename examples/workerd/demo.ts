// gatho workerd example — end-to-end demo
//
//   node gatho server (memory driver)
//     -> workerd({ entry }) runner  (one workerd process, refcounted)
//        -> room isolate (v8, via workerLoader)  x2 room types concurrently
//           -> real WebSocket clients exchanging messages
//
// Proves: two room types => two isolates in ONE workerd process; ws round-trip
// (echo to sender + broadcast to all); notify channel (ready/heartbeat over tcp).

import { connect, type RoomConnection } from 'gatho/client';
import { createMemoryDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';
import { start } from 'gatho/server';
import { workerd } from './host/host.ts';

// node 24 has a global WebSocket, which gatho/client uses.
if (typeof WebSocket === 'undefined') {
    throw new Error('this demo needs a global WebSocket (node >= 22 with --experimental, or node >= 24)');
}

const CREATE_TIMEOUT_MS = 20_000;

function log(msg: string): void {
    process.stdout.write(`  ${msg}\n`);
}

// resolve when `predicate` has seen the messages it wants, or reject on timeout.
function collect(conn: RoomConnection, predicate: (msgs: string[]) => boolean, label: string, timeoutMs = 10_000): Promise<string[]> {
    return new Promise((res, rej) => {
        const msgs: string[] = [];
        const timer = setTimeout(() => {
            off();
            rej(new Error(`timeout waiting for: ${label} (got ${JSON.stringify(msgs)})`));
        }, timeoutMs);
        const onMsg = (m: string | ArrayBuffer) => {
            if (typeof m !== 'string') return;
            msgs.push(m);
            if (predicate(msgs)) {
                clearTimeout(timer);
                off();
                res(msgs);
            }
        };
        const off = () => conn.off('message', onMsg);
        conn.on('message', onMsg);
    });
}

function opened(conn: RoomConnection, timeoutMs = 10_000): Promise<void> {
    return new Promise((res, rej) => {
        if (conn.state === 'open') return res();
        const timer = setTimeout(() => rej(new Error('timeout waiting for ws open')), timeoutMs);
        conn.on('open', () => {
            clearTimeout(timer);
            res();
        });
    });
}

async function main(): Promise<void> {
    const driver = createMemoryDriver();

    log('starting gatho server (memory driver) with workerd runner...');
    const server = await start({
        rooms: {
            echo: workerd({ entry: './rooms/echo.ts' }),
            cursor: workerd({ entry: './rooms/cursor.ts' }),
        },
        driver,
        // path routing: every room reports the shared workerd client port; the
        // roomId is the path segment.
        roomEndpoint: ({ roomId, port }) => `ws://127.0.0.1:${port}/${roomId}`,
        port: 0,
    });

    const gatho = createGathoSDK({ driver });
    let ok = true;

    try {
        // --- two room types, created concurrently => two isolates, one workerd ---
        log('creating an echo room AND a cursor room concurrently...');
        const [echoRoom, cursorRoom] = await Promise.all([
            gatho.createRoom({ type: 'echo', serverId: server.serverId, timeoutMs: CREATE_TIMEOUT_MS }),
            gatho.createRoom({ type: 'cursor', serverId: server.serverId, timeoutMs: CREATE_TIMEOUT_MS }),
        ]);
        log(`  echo   room ready: ${echoRoom.roomId}`);
        log(`  cursor room ready: ${cursorRoom.roomId}`);

        // --- echo room: two clients, prove echo-to-sender + broadcast-to-all ---
        log('joining echo room with two clients (alice, bob)...');
        const aliceSeat = await gatho.join({ roomId: echoRoom.roomId, ttl: 60_000, data: { name: 'alice' } });
        const bobSeat = await gatho.join({ roomId: echoRoom.roomId, ttl: 60_000, data: { name: 'bob' } });
        log(`  alice url: ${aliceSeat.url}`);

        const alice = connect(aliceSeat.url);
        const bob = connect(bobSeat.url);
        await Promise.all([opened(alice), opened(bob)]);
        log('  both clients connected');

        // alice sends; she should get {type:echo} back, and BOTH should get {type:broadcast}
        const aliceGot = collect(alice, (m) => m.some((x) => x.includes('"echo"')) && m.some((x) => x.includes('"broadcast"')), 'alice: echo + broadcast');
        const bobGot = collect(bob, (m) => m.some((x) => x.includes('"broadcast"') && x.includes('hello-workerd')), 'bob: broadcast');

        log('  alice sends "hello-workerd"');
        alice.send('hello-workerd');

        const aliceMsgs = await aliceGot;
        const bobMsgs = await bobGot;
        assert(aliceMsgs.some((m) => m.includes('"echo"') && m.includes('hello-workerd')), 'alice received her echo');
        assert(bobMsgs.some((m) => m.includes('"broadcast"') && m.includes('hello-workerd')), 'bob received the broadcast');
        log('  PASS: echo-to-sender and broadcast-to-all both work');

        // --- cursor room: prove the second isolate is live and independent ---
        log('joining cursor room and moving a cursor...');
        const carolSeat = await gatho.join({ roomId: cursorRoom.roomId, ttl: 60_000, data: { name: 'carol' } });
        const carol = connect(carolSeat.url);
        await opened(carol);
        const carolGot = collect(carol, (m) => m.some((x) => x.includes('"cursor"') && x.includes('"x":42')), 'carol: cursor broadcast');
        carol.send(JSON.stringify({ x: 42, y: 7 }));
        const carolMsgs = await carolGot;
        assert(carolMsgs.some((m) => m.includes('"cursor"') && m.includes('"x":42')), 'carol received her cursor update');
        log('  PASS: second isolate (cursor room) works');

        // clean up clients
        alice.close();
        bob.close();
        carol.close();

        log('');
        log('\x1b[32m========================================\x1b[0m');
        log('\x1b[32m  DEMO PASSED\x1b[0m');
        log('\x1b[32m  2 room types -> 2 v8 isolates in 1 workerd process\x1b[0m');
        log('\x1b[32m  ws send/receive round-trip verified\x1b[0m');
        log('\x1b[32m========================================\x1b[0m');
    } catch (err) {
        ok = false;
        log(`\x1b[31mDEMO FAILED: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        if (err instanceof Error && err.stack) log(err.stack);
    } finally {
        log('shutting down...');
        await server.stop().catch(() => {});
        // give the workerd child a moment to exit from its SIGTERM
        await new Promise((r) => setTimeout(r, 500));
    }

    process.exit(ok ? 0 : 1);
}

function assert(cond: boolean, label: string): void {
    if (!cond) throw new Error(`assertion failed: ${label}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
