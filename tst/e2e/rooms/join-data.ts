// join-data room — sends joinData back to the client on join
import { create } from 'gatho/room';

const room = create({
    onAuth: (joinData: Record<string, unknown>) => ({ ok: true, data: { joinData } }),
    onJoin: (client) => {
        client.send(JSON.stringify({ type: 'join-data', data: client.data.joinData }));
    },
});
await room.start();
