// join-data room — sends joinData back to the client on join
import { auth, start } from '../../../room';

await start({
    onAuth: (joinData: Record<string, unknown>) => auth.ok({ joinData }),
    onJoin: (room, client) => {
        room.send(client, { type: 'join-data', data: client.data.joinData });
    },
});
