import { create } from 'gatho/room';

const room = create({
    onAuth: () => ({ ok: true, data: {} }),

    onDrop: (client) => {
        client.allowReconnection(30_000); // hold seat for 30s
    },

    onReconnect: (client) => {
        client.send(JSON.stringify({ type: 'welcome-back' }));
    },
});

await room.start();
