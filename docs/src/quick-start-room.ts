// counter-room.ts
import { auth, start } from 'gatho/room';

let count = 0;

await start({
    onAuth: () => auth.ok(),

    onJoin: (room, client) => {
        room.send(client, { type: 'count', count });
    },

    onMessage: (room, _client, message: { type: 'increment' | 'decrement' }) => {
        if (message.type === 'increment') count++;
        if (message.type === 'decrement') count--;
        room.broadcast({ type: 'count', count });
    },
});
