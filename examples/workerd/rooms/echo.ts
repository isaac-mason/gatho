// A room module: state lives at module scope, callbacks close over it. Each loaded
// isolate evaluates this module fresh, so module-scope state is per-room — exactly
// like a subprocess room.
//
// It exports a plain options object (this example's OWN convention, NOT a gatho
// API): a workerd module can't call top-level `start()` because env/bindings only
// arrive per-request, so the module exports the options and the adapter calls
// `start(options, { transport, server })` on the first request. See README.

import { auth, type StartOptions } from 'gatho/room';

type ClientData = { name: string };

let messageCount = 0;

export default {
    onAuth: (_room, joinData: { name?: string }) => auth.ok({ name: joinData.name ?? 'anon' }),

    onJoin: (room, client) => {
        room.broadcast(JSON.stringify({ type: 'join', name: client.data.name, count: room.clients.count() }));
    },

    onMessage: (room, client, message) => {
        if (typeof message !== 'string') return;
        messageCount++;
        // echo back to the sender AND broadcast to everyone — proves both paths.
        room.send(client, JSON.stringify({ type: 'echo', from: client.data.name, text: message, seq: messageCount }));
        room.broadcast(JSON.stringify({ type: 'broadcast', from: client.data.name, text: message }));
    },

    onLeave: (room, client) => {
        room.broadcast(JSON.stringify({ type: 'leave', name: client.data.name, count: room.clients.count() }));
    },
} satisfies StartOptions<ClientData>;
