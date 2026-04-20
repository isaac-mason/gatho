import { auth, start } from 'gatho/room';

// opt in to standalone mode — skips jwt auth and ipc.
// throws if `standalone` is omitted and no GATHO_* env vars are set.
await start({
    standalone: true,
    port: 8080,
    onAuth: () => auth.ok(),
    onMessage: (room, client, message) => room.send(client, message),
});
