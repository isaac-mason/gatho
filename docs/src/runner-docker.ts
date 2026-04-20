// runner-docker.ts — custom runner using the runner() factory
import { spawn } from 'node:child_process';
import { createRedisDriver } from 'gatho/driver';
import { runner, start } from 'gatho/server';

const dockerRunner = runner((ctx) => {
    const gameMode = String(ctx.data.gameMode ?? 'classic');

    const child = spawn('docker', [
        'run', '--rm', '--network=host',
        '--name', `room-${ctx.roomId}`,
        '--memory', '512m',
        '-v', '/tmp/gatho-ipc:/tmp/gatho-ipc',
        ...Object.entries(ctx.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        '-e', `GAME_MODE=${gameMode}`,
        'my-game-image:latest',
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    child.on('exit', (code) => ctx.stopped(code));

    return () => {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        timer.unref();
    };
});

await start({
    rooms: { game: dockerRunner },
    driver: createRedisDriver({ url: 'redis://localhost:6379' }),
    roomEndpoint: ({ port }) => `wss://my-host/${port}`,
    tags: { region: 'us-east-1' },
});
