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
        room.broadcast({
            type: 'join',
            user: client.data.username,
            ts: Date.now(),
        });
    },

    onMessage: (room, client, message: { type?: string }) => {
        if (message.type === 'ping') {
            pingCount++;
            room.send(client, {
                type: 'pong',
                pingCount,
                server: room.serverId,
                ts: Date.now(),
            });
        }
    },

    onLeave: (room, client) => {
        room.broadcast({
            type: 'leave',
            user: client.data.username,
            ts: Date.now(),
        });
    },
});
