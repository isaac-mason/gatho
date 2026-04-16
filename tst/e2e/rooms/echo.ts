// echo room — sends every message back to the sender
import { auth, start } from '../../../room';

await start({
    onAuth: () => auth.ok({}),
    onMessage: (room, client, _message: unknown) => room.send(client, _message),
});
