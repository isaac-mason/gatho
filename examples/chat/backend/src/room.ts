import { auth, start } from 'gatho/room';

const messages: Array<{ user: string; text: string; timestamp: number }> = [];

await start({
    onAuth: (joinData: { displayName?: string }) => {
        const username = joinData.displayName || 'anonymous';
        return auth.ok({ username });
    },

    onJoin: (room, client) => {
        room.broadcast({
            type: 'join',
            user: client.data.username,
            timestamp: Date.now(),
        });
    },

    onMessage: (room, client, message: { text: string }) => {
        const msg = {
            user: client.data.username,
            text: message.text,
            timestamp: Date.now(),
        };

        messages.push(msg);

        room.broadcast({
            type: 'message',
            ...msg,
        });
    },

    onLeave: (room, client) => {
        room.broadcast({
            type: 'leave',
            user: client.data.username,
            timestamp: Date.now(),
        });
    },
});
