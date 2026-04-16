import { auth, start } from 'gatho/room';

await start({
    onAuth: () => auth.ok(),

    onDrop: (room, client) => {
        room.allowReconnection(client, 30_000); // hold seat for 30s
    },

    onReconnect: (room, client) => {
        room.send(client, JSON.stringify({ type: 'welcome-back' }));
    },
});
