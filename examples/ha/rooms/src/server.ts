// ha example — gatho server entrypoint
// each server instance runs this file. rooms run as subprocesses.
// multiple instances share state via redis.
// rooms get os-assigned ports, fronted by a caddy reverse proxy.
// clients connect through caddy: ws://localhost:{caddy_port}/{room_port}?token=...
//
// env vars:
//   GATHO_REDIS_URL   — redis connection url (default redis://localhost:6379)
//   GATHO_CADDY_PORT  — the caddy port fronting this server instance (required)
//   GATHO_HOST        — hostname for room endpoints (default localhost)
//   GATHO_PORT        — health check port for this server instance (required)

import { createRedisDriver } from 'gatho/driver';
import { start, subprocess } from 'gatho/server';

const caddyPort = process.env.GATHO_CADDY_PORT;
if (!caddyPort) {
    console.error('  GATHO_CADDY_PORT is required');
    process.exit(1);
}

const port = process.env.GATHO_PORT;
if (!port) {
    console.error('  GATHO_PORT is required');
    process.exit(1);
}

const host = process.env.GATHO_HOST ?? 'localhost';
const redisUrl = process.env.GATHO_REDIS_URL ?? 'redis://localhost:6379';

const server = await start({
    rooms: {
        ping: subprocess(['bun', 'run', new URL('./ping-room.ts', import.meta.url).pathname]),
    },
    driver: createRedisDriver({ url: redisUrl }),
    // room on ephemeral port -> client connects through caddy at /{room_port}
    roomEndpoint: ({ port }) => `ws://${host}:${caddyPort}/${port}`,
    port: Number(port),
});

console.log('');
console.log('  \x1b[1mgatho\x1b[0m \x1b[2mha example — server\x1b[0m');
console.log('');
console.log(`  \x1b[2mhost\x1b[0m     ${host}`);
console.log(`  \x1b[2mhealth\x1b[0m   :${port}`);
console.log(`  \x1b[2mcaddy\x1b[0m    :${caddyPort}`);
console.log(`  \x1b[2mredis\x1b[0m    ${redisUrl}`);
console.log(`  \x1b[2mserver\x1b[0m   ${server.serverId}`);
console.log(`  \x1b[2mrooms\x1b[0m    ws via caddy (os-assigned ports)`);
console.log('');

const shutdown = async () => {
    console.log('\n  \x1b[2mshutting down...\x1b[0m');
    await server.stop();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
