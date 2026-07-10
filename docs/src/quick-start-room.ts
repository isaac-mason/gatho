// counter-room.ts
import { auth, create } from 'gatho/room';

let count = 0;

const room = create({
    onAuth: () => auth.ok(),

    onJoin: (client) => {
        client.send(JSON.stringify({ type: 'count', count }));
    },

    onMessage: (_client, message) => {
        if (typeof message !== 'string') return;

        const parsed = JSON.parse(message) as { type: 'increment' | 'decrement' };

        if (parsed.type === 'increment') {
            count++;
        } else if (parsed.type === 'decrement') {
            count--;
        }

        room.broadcast(JSON.stringify({ type: 'count', count }));
    },
});

await room.start();
