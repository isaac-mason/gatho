import { auth, create } from 'gatho/room';

const room = create({
    onAuth: () => auth.ok(),

    onDrop: (client) => {
        client.allowReconnection(30_000); // hold seat for 30s
    },

    onReconnect: (client) => {
        client.send(JSON.stringify({ type: 'welcome-back' }));
    },
});

await room.start();
