import { auth, create } from 'gatho/room';

const room = create({
    // return auth.ok(data) to accept, auth.fail(reason) to reject.
    // callbacks close over `room` — no room parameter is passed.
    onAuth: (joinData: { displayName: string }) => {
        if (room.clients.count() >= 10) return auth.fail('room is full');
        return auth.ok({ displayName: joinData.displayName });
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
