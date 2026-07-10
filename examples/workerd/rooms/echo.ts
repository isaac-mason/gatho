// A room module: state lives at module scope, callbacks close over it. Each loaded
// isolate evaluates this module fresh, so module-scope state is per-room — exactly
// like a subprocess room.
//
// It exports a factory `(room) => options` (this example's OWN convention, NOT a
// gatho API): a workerd module can't call top-level `create()` because env/bindings
// only arrive per-request, so the module exports a factory and the adapter runs
// `create(factory(room))` + `room.start()` on the first request. the two-phase room
// api drops the `room` param from callbacks, so the factory threads the handle in.
// See README.

import type { RoomModule } from '../adapter/index';

type ClientData = { name: string };

let messageCount = 0;

const echo: RoomModule<ClientData> = (room) => ({
    onAuth: (joinData: { name?: string }) => ({ ok: true, data: { name: joinData.name ?? 'anon' } }),

    onJoin: (client) => {
        room.broadcast(JSON.stringify({ type: 'join', name: client.data.name, count: room.clients.count() }));
    },

    onMessage: (client, message) => {
        if (typeof message !== 'string') return;
        messageCount++;
        // echo back to the sender AND broadcast to everyone — proves both paths.
        client.send(JSON.stringify({ type: 'echo', from: client.data.name, text: message, seq: messageCount }));
        room.broadcast(JSON.stringify({ type: 'broadcast', from: client.data.name, text: message }));
    },

    onLeave: (client) => {
        room.broadcast(JSON.stringify({ type: 'leave', name: client.data.name, count: room.clients.count() }));
    },
});

export default echo;
