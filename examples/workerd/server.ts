// gatho workerd example — SPA backend (onebox)
//
// replicates website/backend/src/server.ts, but the landing room runs as a v8
// isolate inside one workerd process (via the workerd() runner) instead of a
// subprocess. node instead of bun, since the workerd host runner is node code.
//
//   node server.ts          this process: gatho control plane + join api
//     └─ workerd (child)    room host: one isolate per landing room
//
// POST /api/join matchmakes into the fullest landing room with space.

import * as http from 'node:http';
import { createMemoryDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';
import { start } from 'gatho/server';
import { workerd } from './host/host.ts';

// uncommon dev ports to dodge conflicts (website uses 7100/7173; we use 73xx).
const API_PORT = 7300; // join api
const SERVER_PORT = 7301; // gatho control-plane http

const driver = createMemoryDriver();

// --- gatho server (control plane + room management) ---

const server = await start({
    rooms: {
        landing: workerd({ entry: './rooms/landing.ts' }),
    },
    driver,
    port: SERVER_PORT,
    // path routing: all rooms share the workerd host's client port; the roomId
    // is the path segment.
    roomEndpoint: ({ roomId, port }) => `ws://localhost:${port}/${roomId}`,
});

const gatho = createGathoSDK({ driver });

// --- mini in-process matchmaking (same policy as the website) ---
// each landing room holds up to MAX_PER_ROOM cursors. a joiner is routed to the
// fullest running room that still has space; when they're all full, a new room
// (= a new isolate, not a new process) is spun up. serialized so a burst of
// joins can't overfill a room or create duplicates.

const MAX_PER_ROOM = 32;

const newRoom = () =>
    gatho.createRoom({ type: 'landing', serverId: server.serverId, data: {}, tags: { name: 'landing' } });

const landingRooms = () => gatho.getRooms({ type: 'landing', status: 'running' });

async function doMatchmake(): Promise<{ url: string; roomId: string }> {
    const rooms = await landingRooms();
    const open = rooms
        .filter((r) => r.clients.length < MAX_PER_ROOM)
        .sort((a, b) => b.clients.length - a.clients.length)[0];
    const roomId = open ? open.roomId : (await newRoom()).roomId;
    const reservation = await gatho.join({ roomId, ttl: 60_000, data: {} });
    return { url: reservation.url, roomId: reservation.roomId };
}

// serialize matchmaking onto a single promise chain
let mmQueue: Promise<unknown> = Promise.resolve();
function matchmake(): Promise<{ url: string; roomId: string }> {
    const run = mmQueue.then(() => doMatchmake());
    mmQueue = run.catch(() => {});
    return run;
}

// keep one room warm so the first visitor doesn't wait on a cold spawn
await newRoom();

// --- empty-room cleanup ---
// destroy landing rooms that have sat empty for a grace period, but always keep
// at least one alive.
const emptySince = new Map<string, number>();
const EMPTY_GRACE_MS = 20_000;

const cleanup = setInterval(async () => {
    const rooms = await landingRooms();
    const now = Date.now();
    let alive = rooms.length;
    for (const r of rooms) {
        if (r.clients.length > 0) {
            emptySince.delete(r.roomId);
            continue;
        }
        const since = emptySince.get(r.roomId);
        if (since === undefined) {
            emptySince.set(r.roomId, now);
        } else if (now - since >= EMPTY_GRACE_MS && alive > 1) {
            await gatho.destroyRoom(r.roomId).catch(() => {});
            emptySince.delete(r.roomId);
            alive--;
        }
    }
    // prune timers for rooms that no longer exist
    const ids = new Set(rooms.map((r) => r.roomId));
    for (const id of [...emptySince.keys()]) if (!ids.has(id)) emptySince.delete(id);
}, 5_000);

// --- join api ---

const corsHeaders: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
};

const apiServer = http.createServer((req, res) => {
    const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    if (req.url === '/api/join' && req.method === 'POST') {
        matchmake()
            .then((seat) => respond(200, seat))
            .catch((err) => {
                console.error('[api] error:', err);
                respond(500, { error: err instanceof Error ? err.message : 'internal server error' });
            });
        return;
    }

    respond(404, { error: 'not found' });
});

await new Promise<void>((resolve) => apiServer.listen(API_PORT, resolve));

// ---

console.log('');
console.log('  \x1b[1mgatho\x1b[0m \x1b[2mworkerd example — multiplayer cursors (rooms as v8 isolates)\x1b[0m');
console.log('');
console.log(`  \x1b[2mapi\x1b[0m        http://localhost:${API_PORT}`);
console.log(`  \x1b[2mfrontend\x1b[0m   http://localhost:7373  \x1b[2m(cd frontend && pnpm run dev)\x1b[0m`);
console.log(`  \x1b[2mrooms\x1b[0m      workerd isolates, matchmaking up to ${MAX_PER_ROOM} per room`);
console.log('');

const shutdown = async () => {
    console.log('\n  \x1b[2mshutting down...\x1b[0m');
    clearInterval(cleanup);
    apiServer.close();
    await server.stop();
    // let the workerd child exit from its SIGTERM
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
