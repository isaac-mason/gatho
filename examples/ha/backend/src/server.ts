// ha example backend — rest api for room management
// uses redis driver (shared with gatho server instances)
//
// endpoints:
//   GET  /api/rooms              list all rooms
//   GET  /api/servers            list all servers
//   POST /api/rooms              create a room
//   POST /api/join               join a room (body: { roomId })
//   POST /api/rooms/:id/dispose  dispose a room if empty

import { createRedisDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';

const API_PORT = parseInt(process.env.API_PORT ?? '4000', 10);
const GATHO_REDIS_URL = process.env.GATHO_REDIS_URL ?? 'redis://localhost:6379';

const gatho = createGathoSDK({ driver: createRedisDriver({ url: GATHO_REDIS_URL }) });

// --- cors ---

const corsHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
};

// --- server ---

const server = Bun.serve({
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
                return Response.json(rooms, { headers: corsHeaders });
            }

            // GET /api/servers — list all servers
            if (url.pathname === '/api/servers' && req.method === 'GET') {
                const servers = await gatho.getServers();
                return Response.json(servers, { headers: corsHeaders });
            }

            // POST /api/rooms — create a room and join the creator
            if (url.pathname === '/api/rooms' && req.method === 'POST') {
                // pick a server that supports 'ping' rooms, least loaded
                const servers = await gatho.getServers();
                const target = servers
                    .filter((s) => s.roomTypes.includes('ping'))
                    .sort((a, b) => a.rooms.length - b.rooms.length)[0];

                if (!target) {
                    return Response.json({ error: 'no servers available' }, { status: 503, headers: corsHeaders });
                }

                // create room on the chosen server
                const room = await gatho.createRoom({
                    type: 'ping',
                    serverId: target.serverId,
                    data: {},
                    tags: {},
                });

                // join the room as the creator
                const reservation = await gatho.join({
                    roomId: room.roomId,
                    ttl: 60_000,
                });

                console.log(`[api] created room ${room.roomId} on server ${room.serverId}`);

                return Response.json(
                    {
                        roomId: room.roomId,
                        serverId: room.serverId,
                        seat: {
                            url: reservation.url,
                            roomId: reservation.roomId,
                        },
                    },
                    { status: 201, headers: corsHeaders },
                );
            }

            // POST /api/join — join a room
            if (url.pathname === '/api/join' && req.method === 'POST') {
                const body = (await req.json()) as { roomId?: string };
                const roomId = body.roomId?.trim();

                if (!roomId) {
                    return Response.json({ error: 'roomId required' }, { status: 400, headers: corsHeaders });
                }

                const reservation = await gatho.join({
                    roomId,
                    ttl: 60_000,
                });

                return Response.json(
                    {
                        url: reservation.url,
                        roomId: reservation.roomId,
                    },
                    { headers: corsHeaders },
                );
            }

            // POST /api/rooms/:id/dispose — dispose a room
            const disposeMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/dispose$/);
            if (disposeMatch && req.method === 'POST') {
                const roomId = disposeMatch[1];
                await gatho.destroyRoom(roomId);
                console.log(`[api] disposed room ${roomId}`);
                return Response.json({ ok: true }, { headers: corsHeaders });
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
                console.log(`[cleanup] destroying empty room ${room.roomId}`);
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
console.log('  gatho ha example — backend api');
console.log('');
console.log(`  api     http://localhost:${API_PORT}`);
console.log(`  redis   ${GATHO_REDIS_URL}`);
console.log('');

const shutdown = () => {
    console.log('  shutting down...');
    clearInterval(cleanupInterval);
    server.stop();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
