// join-data room — sends joinData back to the client on join
import { auth, start } from 'gatho/room';

await start({
    onAuth: (_room, joinData: Record<string, unknown>) => auth.ok({ joinData }),
    onJoin: (room, client) => {
        room.send(client, JSON.stringify({ type: 'join-data', data: client.data.joinData }));
    },
});
