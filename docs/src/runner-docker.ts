import { spawn } from 'node:child_process';
import { createRedisDriver } from 'gatho/driver';
import { runner, start } from 'gatho/server';

// host and container share this dir so GATHO_SOCKET resolves inside the container
const SOCKET_DIR = '/tmp/gatho-ipc';

const dockerRunner = runner((ctx) => {
    const gameMode = String(ctx.data.gameMode ?? 'classic');

    const child = spawn('docker', [
        'run',
        // remove the container when it exits
        '--rm',
        // use host networking (simpler setup, you could also do port mapping)
        '--network=host',
        // give the container a name for easier debugging
        '--name', `room-${ctx.roomId}`,
        // limit memory
        '--memory', '512m',
        // limit CPU
        '--cpus', '1',
        // mount only THIS room's socket dir so the room can talk to the server
        // but can't reach sibling rooms' sockets. ctx.socketDir is the room's
        // own directory; mount it where the room expects to find GATHO_SOCKET.
        '-v', `${ctx.socketDir}:${ctx.socketDir}`,
        // forward gatho default env vars to the container
        ...Object.entries(ctx.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        // set a game mode env var for the container based on ctx.data
        '-e', `GAME_MODE=${gameMode}`,
        // our docker image, runs gatho/room's start() within
        'my-game-image:latest',
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    // when the child exits, tell the server the room stopped
    child.on('exit', (code) => ctx.stopped(code));

    // destructor that stops the container
    return () => {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        timer.unref();
    };
});

await start({
    socketDir: SOCKET_DIR,
    rooms: { game: dockerRunner },
    driver: createRedisDriver({ url: 'redis://localhost:6379' }),
    roomEndpoint: ({ port }) => `wss://my-host/${port}`,
    tags: { region: 'example', foo: 'bar' },
});
