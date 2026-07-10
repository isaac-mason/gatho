// A minimal multiplayer-cursor room: each client sends {x,y}; the room fans out
// everyone's latest position. Same factory shape as echo.ts — a second room
// type proves two independent isolates in one workerd process.
//
// Exports a `(room) => options` factory (this example's adapter convention, not a
// gatho API — see README and rooms/echo.ts).

import type { RoomModule } from '../adapter/index';

type ClientData = { name: string };
type Pos = { x: number; y: number };

const positions = new Map<string, Pos>();

const cursor: RoomModule<ClientData> = (room) => ({
    onAuth: (joinData: { name?: string }) => ({ ok: true, data: { name: joinData.name ?? 'anon' } }),

    onJoin: (client) => {
        positions.set(client.id, { x: 0, y: 0 });
        room.broadcast(JSON.stringify({ type: 'presence', count: room.clients.count() }));
    },

    onMessage: (client, message) => {
        if (typeof message !== 'string') return;
        try {
            const pos = JSON.parse(message) as Pos;
            positions.set(client.id, pos);
            room.broadcast(JSON.stringify({ type: 'cursor', id: client.id, name: client.data.name, ...pos }));
        } catch {
            // ignore malformed
        }
    },

    onLeave: (client) => {
        positions.delete(client.id);
        room.broadcast(JSON.stringify({ type: 'presence', count: room.clients.count() }));
    },
});

export default cursor;
