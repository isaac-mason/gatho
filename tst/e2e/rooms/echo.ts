// echo room — sends every message back to the sender
import { auth, create } from 'gatho/room';

const room = create({
    onAuth: () => auth.ok({}),
    onMessage: (client, message) => client.send(message),
});
await room.start();
