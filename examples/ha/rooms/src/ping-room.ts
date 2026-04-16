// ha example — ping room subprocess entrypoint
// spawned by the gatho server when a ping room is created.
// client sends { type: "ping" }, room responds with { type: "pong", server, ts }

import { auth, start } from 'gatho/room';

// room state
let pingCount = 0;

console.log(`[ping-room] starting room with pid ${process.pid}`);

await start({
    onAuth: () => {
        return auth.ok({ username: 'player' });
    },

    onJoin: (room, client) => {
        room.broadcast(
            JSON.stringify({
                type: 'join',
                user: client.data.username,
                ts: Date.now(),
            }),
        );
    },

    onMessage: (room, client, message) => {
        if (typeof message !== 'string') return;
        const parsed = JSON.parse(message) as { type?: string };
        if (parsed.type === 'ping') {
            pingCount++;
            room.send(
                client,
                JSON.stringify({
                    type: 'pong',
                    pingCount,
                    server: room.serverId,
                    ts: Date.now(),
                }),
            );
        }
    },

    onLeave: (room, client) => {
        room.broadcast(
            JSON.stringify({
                type: 'leave',
                user: client.data.username,
                ts: Date.now(),
            }),
        );
    },
});
