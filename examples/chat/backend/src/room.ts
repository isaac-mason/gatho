import { auth, create } from 'gatho/room';

const messages: Array<{ user: string; text: string; timestamp: number }> = [];

const room = create({
    onAuth: (joinData: { displayName?: string }) => {
        const username = joinData.displayName || 'anonymous';
        return auth.ok({ username });
    },

    onJoin: (client) => {
        room.broadcast(
            JSON.stringify({
                type: 'join',
                user: client.data.username,
                timestamp: Date.now(),
            }),
        );
    },

    onMessage: (client, message) => {
        if (typeof message !== 'string') return;
        const parsed = JSON.parse(message) as { text: string };
        const msg = {
            user: client.data.username,
            text: parsed.text,
            timestamp: Date.now(),
        };

        messages.push(msg);

        room.broadcast(
            JSON.stringify({
                type: 'message',
                ...msg,
            }),
        );
    },

    onLeave: (client) => {
        room.broadcast(
            JSON.stringify({
                type: 'leave',
                user: client.data.username,
                timestamp: Date.now(),
            }),
        );
    },
});

await room.start();
