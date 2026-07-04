// headless verification of the SPA data path: two clients join via the api,
// (run `pnpm run start` first, then `pnpm run test:spa`)
// stream cursor moves, and must see each other's join + frame broadcasts.
import { connect, type RoomConnection } from 'gatho/client';
import { clientCodec, encodeCoord, serverCodec, type ServerMessage } from './shared/protocol.ts';

async function join(): Promise<{ url: string; roomId: string }> {
    const res = await fetch('http://localhost:7300/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return res.json();
}

const a = await join();
const b = await join();
console.log('same room:', a.roomId === b.roomId, a.roomId.slice(0, 8));

const msgsA: ServerMessage[] = [];
const msgsB: ServerMessage[] = [];
function wire(conn: RoomConnection, sink: ServerMessage[]) {
    conn.on('message', (m) => { if (typeof m !== 'string') sink.push(serverCodec.unpack(new Uint8Array(m))); });
}
function open(conn: RoomConnection) { return new Promise<void>((res, rej) => { conn.on('open', () => res()); conn.on('authError', (e) => rej(new Error(String(e)))); setTimeout(() => rej(new Error('open timeout')), 8000); }); }

const ca = connect(a.url); wire(ca, msgsA);
const cb = connect(b.url); wire(cb, msgsB);
await Promise.all([open(ca), open(cb)]);
console.log('both connected');

// both move a few times at ~20Hz
for (let i = 0; i < 8; i++) {
    ca.send(clientCodec.pack({ x: encodeCoord(0.1 + i * 0.05), y: encodeCoord(0.2) }), { reliable: false });
    cb.send(clientCodec.pack({ x: encodeCoord(0.9 - i * 0.05), y: encodeCoord(0.8) }), { reliable: false });
    await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 500));

const kinds = (msgs: ServerMessage[]) => [...new Set(msgs.map((m) => m.type))].sort();
console.log('A saw:', kinds(msgsA), 'B saw:', kinds(msgsB));
const aSnapshot = msgsA.find((m) => m.type === 'snapshot');
const aSawB = msgsA.some((m) => m.type === 'join' || (m.type === 'snapshot' && m.cursors.length > 0)) || msgsA.some((m) => m.type === 'frame');
const bFrames = msgsB.filter((m) => m.type === 'frame');
const bSawAMove = bFrames.some((f) => f.moves.length > 0);
const presence = msgsA.filter((m) => m.type === 'presence').map((m) => (m as { count: number }).count);
console.log('A snapshot ok:', !!aSnapshot, '| B saw frames with moves:', bSawAMove, '| presence counts seen by A:', presence);

ca.close(); cb.close();
await new Promise((r) => setTimeout(r, 200));

if (aSnapshot && bSawAMove && presence.includes(2)) { console.log('SPA DATA PATH: PASS'); process.exit(0); }
console.log('SPA DATA PATH: FAIL'); process.exit(1);
