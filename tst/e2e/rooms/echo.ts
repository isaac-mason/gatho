// echo room — sends every message back to the sender
import { create } from 'gatho/room';

const room = create({
    onAuth: () => ({ ok: true, data: {} }),
    onMessage: (client, message) => client.send(message),
});
await room.start();
