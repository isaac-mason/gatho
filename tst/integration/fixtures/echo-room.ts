// echo room fixture — spawned as a real subprocess by tcp-notify.test.ts.
// create() reads GATHO_NOTIFY_SOCKET from the env; when the runner sets up a tcp
// notify channel that env var is a `tcp://host:port?token=...` uri, so the room
// dials the parent server over tcp (token frame first) with no code changes.
import { auth, create } from 'gatho/room';

const room = create({
    onAuth: () => auth.ok({}),
    onMessage: (client, message) => client.send(message),
});
await room.start();
