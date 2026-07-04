import Bun from 'bun';
import { createMemoryDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';
import { start, subprocess } from 'gatho/server';

const API_PORT = 3100;

// shared in-memory driver — one process, no redis needed
const driver = createMemoryDriver();

// --- gatho server (control plane + room management) ---

const server = await start({
    rooms: {
        chat: subprocess(['bun', 'run', new URL('./room.ts', import.meta.url).pathname]),
    },
    driver,
    roomEndpoint: ({ port }) => `ws://localhost:${port}`,
});

// --- lobby api (room creation + seat reservation) ---

const gatho = createGathoSDK({ driver });

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
            // GET /api/rooms — list all rooms
            if (url.pathname === '/api/rooms' && req.method === 'GET') {
                const rooms = await gatho.getRooms();
                const result = rooms.map((r) => ({
                    roomId: r.roomId,
                    roomType: r.roomType,
                    name: r.tags.name ?? r.roomId,
                    clientCount: r.clients.filter((c) => c.status === 'connected').length,
                    createdAt: r.createdAt,
                }));
                return Response.json(result, { headers: corsHeaders });
            }

            // POST /api/rooms — create a new room and join the creator
            // body: { name: string, displayName?: string }
            if (url.pathname === '/api/rooms' && req.method === 'POST') {
                const body = (await req.json()) as { name: string; displayName?: string };
                const name = body.name?.trim();
                const displayName = body.displayName?.trim();

                if (!name) {
                    return Response.json({ error: 'name required' }, { status: 400, headers: corsHeaders });
                }

                // create room — directly on this server, no server discovery needed
                const room = await gatho.createRoom({
                    type: 'chat',
                    serverId: server.serverId,
                    data: {},
                    tags: { name },
                });

                // join the room as the creator — pass displayName via join data
                const reservation = await gatho.join({
                    roomId: room.roomId,
                    ttl: 60_000,
                    data: displayName ? { displayName } : {},
                });

                console.log(`  \x1b[2m[api] created room:\x1b[0m ${room.roomId}`);

                return Response.json(
                    {
                        roomId: room.roomId,
                        name,
                        seat: {
                            url: reservation.url,
                            roomId: reservation.roomId,
                        },
                    },
                    { status: 201, headers: corsHeaders },
                );
            }

            // POST /api/join — join a room
            // body: { roomId: string, displayName?: string }
            if (url.pathname === '/api/join' && req.method === 'POST') {
                const body = (await req.json()) as { roomId: string; displayName?: string };
                const roomId = body.roomId?.trim();
                const displayName = body.displayName?.trim();

                if (!roomId) {
                    return Response.json({ error: 'roomId required' }, { status: 400, headers: corsHeaders });
                }

                const reservation = await gatho.join({
                    roomId,
                    ttl: 60_000,
                    data: displayName ? { displayName } : {},
                });

                return Response.json(
                    {
                        url: reservation.url,
                        roomId: reservation.roomId,
                    },
                    { headers: corsHeaders },
                );
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

// --- empty room cleanup ---
// tracks when each room was first seen with 0 clients.
// if a room stays empty for 10s, it gets destroyed.

const emptyRoomSince = new Map<string, number>();
const EMPTY_THRESHOLD_MS = 10_000;

const cleanupInterval = setInterval(async () => {
    const rooms = await gatho.getRooms();
    const now = Date.now();

    // track which rooms are still alive so we can prune stale entries
    const activeRoomIds = new Set<string>();

    for (const room of rooms) {
        activeRoomIds.add(room.roomId);

        if (room.clients.filter((c) => c.status === 'connected').length === 0) {
            const firstEmpty = emptyRoomSince.get(room.roomId);
            if (firstEmpty === undefined) {
                // first time seeing this room empty
                emptyRoomSince.set(room.roomId, now);
            } else if (now - firstEmpty >= EMPTY_THRESHOLD_MS) {
                // empty for long enough — destroy it
                console.log(`  \x1b[2m[cleanup] destroying empty room\x1b[0m ${room.roomId}`);
                await gatho.destroyRoom(room.roomId);
                emptyRoomSince.delete(room.roomId);
            }
        } else {
            // room has clients — reset the timer
            emptyRoomSince.delete(room.roomId);
        }
    }

    // prune tracking entries for rooms that no longer exist
    for (const roomId of emptyRoomSince.keys()) {
        if (!activeRoomIds.has(roomId)) {
            emptyRoomSince.delete(roomId);
        }
    }
}, 5_000);

// ---

console.log('');
console.log('  \x1b[1mgatho\x1b[0m \x1b[2mchatrooms example — onebox\x1b[0m');
console.log('');
console.log(`  \x1b[2mapi\x1b[0m        http://localhost:${API_PORT}`);
console.log(`  \x1b[2mfrontend\x1b[0m   http://localhost:5173  \x1b[2m(cd frontend && pnpm vite)\x1b[0m`);
console.log(`  \x1b[2mrooms\x1b[0m      direct ws (os-assigned ports)`);
console.log('');

// graceful shutdown
const shutdown = async () => {
    console.log('\n  \x1b[2mshutting down...\x1b[0m');
    clearInterval(cleanupInterval);
    apiServer.stop();
    await server.stop();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
