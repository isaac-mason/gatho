import { create } from 'gatho/room';

const room = create({
    onAuth: () => ({ ok: true, data: {} }),
});

// --- (a) pacing a large send ---
//
// a big world snapshot (voxel chunks, a full lobby state) can be tens of MB. push
// it all at once and it piles up in the socket's outbound buffer faster than the
// peer can drain it — memory balloons and latency for everything else spikes.
// instead, stream it in chunks and check client.bufferedAmount between chunks,
// yielding while the buffer is high so the socket can drain.

const HIGH_WATER = 1 << 20; // 1MB — pause new chunks above this
const CHUNK_BYTES = 64 * 1024;

async function streamSnapshot(clientId: string, snapshot: Uint8Array): Promise<void> {
    for (let offset = 0; offset < snapshot.byteLength; offset += CHUNK_BYTES) {
        // re-fetch the handle each iteration — the client may have left mid-stream.
        const client = room.clients.get(clientId);
        if (!client) return;

        // wait for the buffer to drain below the high-water mark before queueing
        // more. a real impl would await an event/timer; a poll keeps the example
        // dependency-free.
        while (client.bufferedAmount > HIGH_WATER) {
            await new Promise((r) => setTimeout(r, 16));
            if (!room.clients.has(clientId)) return;
        }

        client.send(snapshot.subarray(offset, offset + CHUNK_BYTES));
    }
}

// --- (b) your own stall-eviction policy ---
//
// gatho ships client.bufferedAmount and NO automatic eviction. a naive
// "disconnect anyone above N bytes" misfires: a bursty payload (that world
// snapshot) briefly parks megabytes in the buffer for a perfectly healthy peer.
// buffered != stalled. the discriminator is DRAIN PROGRESS — a stalled peer's
// buffer stays high WITHOUT shrinking across a sweep; a busy-but-healthy peer's
// buffer falls as the OS flushes it.
//
// so: sweep periodically, remember each client's last buffered depth, and only
// evict a peer whose buffer is both high AND not lower than last time. (prior
// art for an automatic version: uWS's maxBackpressure caps the buffer and drops
// the socket; Bun's ws.send() returns a negative value on backpressure so you can
// stop feeding it. we expose the raw signal and let you pick the policy.)

const STALL_LIMIT = 4 << 20; // 4MB — only consider eviction above this
const lastBuffered = new Map<string, number>();

function sweepForStalls() {
    for (const client of room.clients) {
        const buffered = client.bufferedAmount;
        const previous = lastBuffered.get(client.id) ?? 0;

        // high AND not draining (>= last sweep) → the peer isn't keeping up.
        if (buffered > STALL_LIMIT && buffered >= previous) {
            client.disconnect();
            lastBuffered.delete(client.id);
            continue;
        }

        lastBuffered.set(client.id, buffered);
    }
}

setInterval(sweepForStalls, 1000);

// keep the streaming helper referenced so tsc doesn't flag it as unused.
void streamSnapshot;

await room.start();
