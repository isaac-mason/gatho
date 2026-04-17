// echo room — sends every message back to the sender
import { auth, start } from '../../../src/room';

await start({
    onAuth: () => auth.ok({}),
    onMessage: (room, client, message) => room.send(client, message),
});
