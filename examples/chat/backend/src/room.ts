import { auth, start } from 'gatho/room';

const messages: Array<{ user: string; text: string; timestamp: number }> = [];

await start({
    onAuth: (_room, joinData: { displayName?: string }) => {
        const username = joinData.displayName || 'anonymous';
        return auth.ok({ username });
    },

    onJoin: (room, client) => {
        room.broadcast(
            JSON.stringify({
                type: 'join',
                user: client.data.username,
                timestamp: Date.now(),
            }),
        );
    },

    onMessage: (room, client, message) => {
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

    onLeave: (room, client) => {
        room.broadcast(
            JSON.stringify({
                type: 'leave',
                user: client.data.username,
                timestamp: Date.now(),
            }),
        );
    },
});
