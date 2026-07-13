import { create } from 'gatho/room';

const room = create({
    // return { ok: true, data } to accept, { ok: false, error } to reject.
    // callbacks close over `room`; no room parameter is passed. keep the `room`
    // read in a statement (the if-guard below), not in the returned expression.
    onAuth: (joinData: { displayName: string }) => {
        if (room.clients.count() >= 10) return { ok: false, error: 'room is full' };
        return { ok: true, data: { displayName: joinData.displayName } };
    },

    // client is authenticated and in the room
    onJoin: (client) => {
        room.broadcast(JSON.stringify({ type: 'joined', id: client.id }));
    },

    // client sent a message
    onMessage: (client, message) => {
        if (typeof message !== 'string') return;
        room.broadcast(JSON.stringify({ type: 'echo', from: client.id, message }));
    },

    // non-consented disconnect: call allowReconnection to hold the seat
    onDrop: (client) => {
        client.allowReconnection(30_000);
    },

    // client reconnected within the window; buffered messages already flushed
    onReconnect: (client) => {
        client.send(JSON.stringify({ type: 'welcome-back' }));
    },

    // client permanently left: consented close, eviction, or window expired
    onLeave: (client) => {
        room.broadcast(JSON.stringify({ type: 'left', id: client.id }));
    },

    // SIGTERM or room.stop()
    onShutdown: () => {
        console.log('shutting down');
    },
});

await room.start();
