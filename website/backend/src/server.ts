import Bun from 'bun';
import { createMemoryDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';
import { start, subprocess } from 'gatho/server';

// uncommon dev ports to dodge conflicts with the usual 3000/5173/8080 crowd.
const API_PORT = 7100; // bun join api
const SERVER_PORT = 7101; // gatho control-plane http

// public origin of this backend in production (e.g. https://rooms.gatho.dev).
// when set, room websocket urls are emitted as wss://<host>/room/<port> so Caddy
// can route them; unset (local dev) falls back to a direct ws://localhost:<port>.
// the frontend is hosted separately (cloudflare pages) and talks to us cross-origin.
const PUBLIC_URL = process.env.PUBLIC_URL;

// shared in-memory driver — one process, no redis needed (onebox)
const driver = createMemoryDriver();

// --- gatho server (control plane + room management) ---

// in production the room is a compiled bun binary (ROOM_BIN); in local dev we
// spawn the .ts directly with bun.
const ROOM_CMD = process.env.ROOM_BIN
    ? [process.env.ROOM_BIN]
    : ['bun', 'run', new URL('./room.ts', import.meta.url).pathname];

const server = await start({
    rooms: {
        landing: subprocess(ROOM_CMD),
    },
    driver,
    port: SERVER_PORT,
    roomEndpoint: ({ port }) =>
        PUBLIC_URL ? `${PUBLIC_URL.replace(/^http/, 'ws')}/room/${port}` : `ws://localhost:${port}`,
});

const gatho = createGathoSDK({ driver });

// --- mini in-process matchmaking ---
// each landing room holds up to MAX_PER_ROOM cursors. a joiner is routed to the
// fullest running room that still has space (keeps rooms lively); when they're
// all full, a new room is spun up. matchmaking is serialized so a burst of joins
// can't overfill a room or create duplicates.

const MAX_PER_ROOM = 32;

const newRoom = () =>
    gatho.createRoom({ type: 'landing', serverId: server.serverId, tags: { name: 'landing' } });

const landingRooms = () => gatho.getRooms({ type: 'landing', status: 'running' });

async function doMatchmake(): Promise<{ url: string; roomId: string }> {
    const rooms = await landingRooms();
    const open = rooms
        .filter((r) => r.clients.length < MAX_PER_ROOM)
        .sort((a, b) => b.clients.length - a.clients.length)[0];
    const roomId = open ? open.roomId : (await newRoom()).roomId;
    const reservation = await gatho.join({ roomId, ttl: 60_000 });
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

const corsHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
};

const apiServer = Bun.serve({
    port: API_PORT,
    async fetch(req) {
        const url = new URL(req.url);

        if (req.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // POST /api/join — matchmake into a landing room with space
            if (url.pathname === '/api/join' && req.method === 'POST') {
                const seat = await matchmake();
                return Response.json(seat, { headers: corsHeaders });
            }

            return new Response('not found', { status: 404, headers: corsHeaders });
        } catch (err) {
            console.error('[api] error:', err);
            const message = err instanceof Error ? err.message : 'internal server error';
            return Response.json({ error: message }, { status: 500, headers: corsHeaders });
        }
    },
    error(err) {
        console.error('[api] unhandled error:', err);
        return Response.json({ error: 'internal server error' }, { status: 500, headers: corsHeaders });
    },
});

// ---

console.log('');
console.log('  \x1b[1mgatho\x1b[0m \x1b[2mwebsite — multiplayer cursors (onebox)\x1b[0m');
console.log('');
console.log(`  \x1b[2mapi\x1b[0m        http://localhost:${API_PORT}`);
console.log(`  \x1b[2mfrontend\x1b[0m   http://localhost:7173  \x1b[2m(cd frontend && pnpm run dev)\x1b[0m`);
console.log(`  \x1b[2mrooms\x1b[0m      matchmaking, up to ${MAX_PER_ROOM} per room`);
console.log('');

const shutdown = async () => {
    console.log('\n  \x1b[2mshutting down...\x1b[0m');
    clearInterval(cleanup);
    apiServer.stop();
    await server.stop();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
