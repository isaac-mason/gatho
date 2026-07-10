// join-data room — sends joinData back to the client on join
import { auth, create } from 'gatho/room';

const room = create({
    onAuth: (joinData: Record<string, unknown>) => auth.ok({ joinData }),
    onJoin: (client) => {
        client.send(JSON.stringify({ type: 'join-data', data: client.data.joinData }));
    },
});
await room.start();
