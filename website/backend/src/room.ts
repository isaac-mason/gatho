import { auth, create } from 'gatho/room';
import { clientCodec, serverCodec } from '../../shared/protocol';

// each visitor is a live cursor. binary protocol (see ../../shared/protocol):
// identity (color + name) is sent once when a cursor first moves; positions are
// batched and broadcast at a slow fixed tick, not rebroadcast per message.

const COLORS = ['#ff5c7c', '#5ca8ff', '#5cffa8', '#ffd95c', '#c45cff', '#ff8c5c', '#5cf0ff', '#a8ff5c'];
const NAMES = ['otter', 'fox', 'crane', 'koi', 'moth', 'lynx', 'wren', 'newt', 'ibis', 'toad', 'hare', 'finch'];

let seq = 0;

interface CursorState {
    cid: number; // compact 2-byte id used on the wire
    color: string;
    name: string;
    x: number; // quantized uint16 (as received)
    y: number;
    announced: boolean; // has its identity been broadcast yet (i.e. has it moved)
    dirty: boolean; // moved since the last tick
}

const state = new Map<string, CursorState>(); // keyed by client.id
let nextCid = 1;

// allocate a free uint16 cid (skips ones currently in use)
function allocCid(): number {
    const used = new Set<number>();
    for (const s of state.values()) used.add(s.cid);
    while (used.has(nextCid) || nextCid === 0) nextCid = (nextCid + 1) & 0xffff;
    const cid = nextCid;
    nextCid = (nextCid + 1) & 0xffff;
    return cid;
}

const room = create({
    onAuth: () => {
        const color = COLORS[seq % COLORS.length];
        const name = `${NAMES[seq % NAMES.length]}-${seq}`;
        seq++;
        return auth.ok({ color, name });
    },

    onJoin: (client) => {
        const { color, name } = client.data as { color: string; name: string };
        const cid = allocCid();
        state.set(client.id, { cid, color, name, x: 0, y: 0, announced: false, dirty: false });

        // snapshot: the newcomer's own identity + everyone already moving
        const cursors: { cid: number; color: string; name: string; x: number; y: number }[] = [];
        for (const s of state.values()) {
            if (s.announced) cursors.push({ cid: s.cid, color: s.color, name: s.name, x: s.x, y: s.y });
        }
        client.send(serverCodec.pack({ type: 'snapshot', you: cid, color, name, cursors }));
        room.broadcast(serverCodec.pack({ type: 'presence', count: room.clients.count() }));
    },

    onMessage: (client, message) => {
        if (typeof message === 'string') return; // binary only
        const s = state.get(client.id);
        if (!s) return;
        const u8 = message instanceof Uint8Array ? message : new Uint8Array(message as ArrayBuffer);
        const m = clientCodec.unpack(u8);
        s.x = m.x;
        s.y = m.y;
        if (!s.announced) {
            // first move — introduce this cursor to everyone, once
            s.announced = true;
            room.broadcast(serverCodec.pack({ type: 'join', cid: s.cid, color: s.color, name: s.name, x: s.x, y: s.y }));
        } else {
            s.dirty = true;
        }
    },

    onLeave: (client) => {
        const s = state.get(client.id);
        if (s) {
            if (s.announced) room.broadcast(serverCodec.pack({ type: 'leave', cid: s.cid }));
            state.delete(client.id);
        }
        room.broadcast(serverCodec.pack({ type: 'presence', count: room.clients.count() }));
    },
});

await room.start();

// batch movement broadcasts at ~15Hz — one binary frame with just the cursors
// that moved this tick.
const TICK_MS = 66;
setInterval(() => {
    const moves: { cid: number; x: number; y: number }[] = [];
    for (const s of state.values()) {
        if (s.dirty) {
            moves.push({ cid: s.cid, x: s.x, y: s.y });
            s.dirty = false;
        }
    }
    if (moves.length > 0) room.broadcast(serverCodec.pack({ type: 'frame', moves }));
}, TICK_MS);
