// the website's multiplayer-cursor room, running as a workerd isolate.
// (ported from website/backend/src/room.ts to this example's plain-options
// export convention — see rooms/echo.ts and the README.)
//
// each visitor is a live cursor. binary protocol (see ../shared/protocol):
// identity (color + name) is sent once when a cursor first moves; positions are
// batched and broadcast at a slow fixed tick.
//
// workerd adaptation: the website room drives the batch tick with a module-level
// `setInterval`. workerd timers only fire while the isolate is active, so a
// free-running interval stalls whenever traffic pauses. instead the flush timer
// is ARMED on demand (first dirty move schedules a one-shot ~66ms flush): while
// cursors stream (~20Hz per client) the isolate is active and the timeout fires
// on schedule; when everyone is idle there's nothing to flush anyway.

import { auth, type Room, type StartOptions } from 'gatho/room';
import { clientCodec, serverCodec } from '../shared/protocol';

const COLORS = ['#ff5c7c', '#5ca8ff', '#5cffa8', '#ffd95c', '#c45cff', '#ff8c5c', '#5cf0ff', '#a8ff5c'];
const NAMES = ['otter', 'fox', 'crane', 'koi', 'moth', 'lynx', 'wren', 'newt', 'ibis', 'toad', 'hare', 'finch'];

type ClientData = { color: string; name: string };

let seq = 0;

interface CursorState {
    cid: number; // compact 2-byte id used on the wire
    color: string;
    name: string;
    x: number; // quantized uint16 (as received)
    y: number;
    announced: boolean; // has its identity been broadcast yet (i.e. has it moved)
    dirty: boolean; // moved since the last flush
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

// --- movement batching (~15Hz), armed on demand ---

const TICK_MS = 66;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(room: Room<ClientData>): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        const moves: { cid: number; x: number; y: number }[] = [];
        for (const s of state.values()) {
            if (s.dirty) {
                moves.push({ cid: s.cid, x: s.x, y: s.y });
                s.dirty = false;
            }
        }
        if (moves.length > 0) room.broadcast(serverCodec.pack({ type: 'frame', moves }));
    }, TICK_MS);
}

export default {
    onAuth: () => {
        const color = COLORS[seq % COLORS.length];
        const name = `${NAMES[seq % NAMES.length]}-${seq}`;
        seq++;
        return auth.ok({ color, name });
    },

    onJoin: (room, client) => {
        const { color, name } = client.data;
        const cid = allocCid();
        state.set(client.id, { cid, color, name, x: 0, y: 0, announced: false, dirty: false });

        // snapshot: the newcomer's own identity + everyone already moving
        const cursors: { cid: number; color: string; name: string; x: number; y: number }[] = [];
        for (const s of state.values()) {
            if (s.announced) cursors.push({ cid: s.cid, color: s.color, name: s.name, x: s.x, y: s.y });
        }
        room.send(client, serverCodec.pack({ type: 'snapshot', you: cid, color, name, cursors }));
        room.broadcast(serverCodec.pack({ type: 'presence', count: room.clients.count() }));
    },

    onMessage: (room, client, message) => {
        if (typeof message === 'string') return; // binary only
        const s = state.get(client.id);
        if (!s) return;
        const m = clientCodec.unpack(new Uint8Array(message));
        s.x = m.x;
        s.y = m.y;
        if (!s.announced) {
            // first move — introduce this cursor to everyone, once
            s.announced = true;
            room.broadcast(serverCodec.pack({ type: 'join', cid: s.cid, color: s.color, name: s.name, x: s.x, y: s.y }));
        } else {
            s.dirty = true;
            scheduleFlush(room);
        }
    },

    onLeave: (room, client) => {
        const s = state.get(client.id);
        if (s) {
            if (s.announced) room.broadcast(serverCodec.pack({ type: 'leave', cid: s.cid }));
            state.delete(client.id);
        }
        room.broadcast(serverCodec.pack({ type: 'presence', count: room.clients.count() }));
    },
} satisfies StartOptions<ClientData>;
