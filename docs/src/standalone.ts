import { create } from 'gatho/room';

// opt in to standalone mode, which skips jwt auth and ipc.
// create() throws if `standalone` is omitted and no GATHO_* env vars are set.
const room = create({
    standalone: true,
    port: 8080,
    onAuth: () => ({ ok: true, data: {} }),
    onMessage: (client, message) => client.send(message),
});

await room.start();
