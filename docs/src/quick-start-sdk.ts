// my-backend.ts
import { createRedisDriver } from 'gatho/driver/redis';
import { createGathoSDK } from 'gatho/sdk';

const gatho = createGathoSDK({ driver: createRedisDriver() });

const servers = await gatho.getServers({ roomTypes: ['counter'] });

// placement policy is yours. here we pick the least-loaded server by current
// room count; you could filter by tags (region, tier), weight by capacity, etc.
const target = servers.sort((a, b) => a.rooms.length - b.rooms.length)[0];

if (!target) {
    throw new Error('no servers available to run a counter room');
}

const room = await gatho.createRoom({
    type: 'counter',
    serverId: target.serverId,
    // data and tags are optional (default {}). pass them to seed the room's
    // create() data or to categorize the room for later filtering.
});

// ttl is optional too (default 30000ms): how long the reservation stays valid.
const seat = await gatho.join({ roomId: room.roomId });

console.log(seat.url);
