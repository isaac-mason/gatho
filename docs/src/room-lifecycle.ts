import { auth, start } from 'gatho/room';

await start({
    // return auth.ok(data) to accept, auth.fail(reason) to reject
    onAuth: (joinData: { displayName: string }, room) => {
        if (room.clients.count() >= 10) return auth.fail('room is full');
        return auth.ok({ displayName: joinData.displayName });
    },

    // client is authenticated and in the room
    onJoin: (room, client) => {
        room.broadcast({ type: 'joined', id: client.id });
    },

    // client sent a message
    onMessage: (room, client, message: { type: string }) => {
        room.broadcast({ type: 'echo', from: client.id, message });
    },

    // non-consented disconnect — call allowReconnection to hold the seat
    onDrop: (room, client) => {
        room.allowReconnection(client, 30_000);
    },

    // client reconnected within the window — buffered messages already flushed
    onReconnect: (room, client) => {
        room.send(client, { type: 'welcome-back' });
    },

    // client permanently left — consented close, eviction, or window expired
    onLeave: (room, client) => {
        room.broadcast({ type: 'left', id: client.id });
    },

    // SIGTERM or room.stop()
    onShutdown: () => {
        console.log('shutting down');
    },
});
