import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unpackFrame } from '../../src/common/protocol';
import { auth, start } from '../../src/room/index';
import type {
    ClientSocket,
    Transport,
    TransportHandlers,
    TransportListenConfig,
    TransportServer,
} from '../../src/room/transport/types';

// stub transport with a controllable per-socket bufferedAmount, so we can simulate
// a stalled consumer whose outbound buffer grows past the cap. models topic pub/sub
// in memory (broadcasts fan out via publish, bypassing the room's per-socket path —
// exactly the case the heartbeat sweep exists to catch).
type Captured = {
    handlers: TransportHandlers;
    server: TransportServer;
    subscribers: Set<RecordingSocket>;
};

type RecordingSocket = {
    socket: ClientSocket;
    // mutable knob: the pretend outbound buffer depth in bytes.
    buffered: number;
    readonly closed: { code: number; reason: string } | null;
};

function stubTransport(sink: { captured?: Captured }): Transport {
    const subscribers = new Set<RecordingSocket>();
    return {
        listen(handlers: TransportHandlers, _config?: TransportListenConfig): Promise<TransportServer> {
            const server: TransportServer = {
                port: 0,
                publish(_topic, data) {
                    for (const rec of subscribers) {
                        if (rec.closed) continue;
                        rec.socket.send(data, true);
                    }
                },
                close() {},
            };
            sink.captured = { handlers, server, subscribers };
            return Promise.resolve(server);
        },
    };
}

function recordingSocket(subscribers: Set<RecordingSocket>): RecordingSocket {
    let closed: { code: number; reason: string } | null = null;

    const rec: RecordingSocket = {
        socket: {
            send(data) {
                // decode to assert nothing unexpected leaks; content isn't asserted here.
                if (typeof data !== 'string') unpackFrame(data);
            },
            close(code, reason) {
                closed = { code, reason };
            },
            subscribe() {
                subscribers.add(rec);
            },
            bufferedAmount() {
                return rec.buffered;
            },
        },
        buffered: 0,
        get closed() {
            return closed;
        },
    };
    return rec;
}

async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
}

describe('room outbound backpressure', () => {
    let sink: { captured?: Captured };

    function handlers(): TransportHandlers {
        if (!sink.captured) throw new Error('transport never captured handlers');
        return sink.captured.handlers;
    }
    function subscribers(): Set<RecordingSocket> {
        if (!sink.captured) throw new Error('transport never captured handlers');
        return sink.captured.subscribers;
    }

    beforeEach(() => {
        sink = {};
    });

    it('evicts a client whose bufferedAmount exceeds the cap on the next send', async () => {
        let leaveCount = 0;
        const room = await start({
            standalone: true,
            transport: stubTransport(sink),
            maxOutboundBufferBytes: 1000,
            onAuth: () => auth.ok({}),
            onLeave: () => {
                leaveCount++;
            },
        });

        const rec = recordingSocket(subscribers());
        handlers().open('c1', rec.socket, {}, {});
        await settle();
        const client = room.clients.get('c1')!;

        // healthy: a send while under the cap does not evict.
        room.send(client, 'ok');
        expect(room.clients.has('c1')).toBe(true);
        expect(rec.closed).toBeNull();

        // the socket stalls — its outbound buffer is now past the cap.
        rec.buffered = 2000;
        room.send(client, 'over');

        // evicted through the standard path: removed and closed 4000 synchronously,
        // onLeave fires on the next microtask (safeCall).
        expect(room.clients.has('c1')).toBe(false);
        expect(rec.closed).toEqual({ code: 4000, reason: 'evicted' });
        await settle();
        expect(leaveCount).toBe(1);
    });

    it('evicts a broadcast-only stalled peer on the heartbeat sweep', async () => {
        vi.useFakeTimers();
        try {
            let leaveCount = 0;
            const room = await start({
                standalone: true,
                transport: stubTransport(sink),
                maxOutboundBufferBytes: 1000,
                onAuth: () => auth.ok({}),
                onLeave: () => {
                    leaveCount++;
                },
            });

            const rec = recordingSocket(subscribers());
            handlers().open('c1', rec.socket, {}, {});
            // drain the open()'s async auth microtasks under fake timers.
            await vi.advanceTimersByTimeAsync(0);
            expect(room.clients.has('c1')).toBe(true);

            // the peer only ever receives broadcasts (which bypass room.send), and it
            // has stalled past the cap. room.send's inline check never runs for it.
            rec.buffered = 5000;
            room.broadcast('tick');
            expect(room.clients.has('c1')).toBe(true); // not caught yet — no per-socket check on broadcast

            // advance one heartbeat interval — the sweep catches it and evicts.
            await vi.advanceTimersByTimeAsync(3000);
            expect(room.clients.has('c1')).toBe(false);
            expect(rec.closed).toEqual({ code: 4000, reason: 'evicted' });
            expect(leaveCount).toBe(1);

            await room.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves a healthy socket (buffered under cap) untouched across sends and sweeps', async () => {
        vi.useFakeTimers();
        try {
            const room = await start({
                standalone: true,
                transport: stubTransport(sink),
                maxOutboundBufferBytes: 1000,
                onAuth: () => auth.ok({}),
            });

            const rec = recordingSocket(subscribers());
            handlers().open('c1', rec.socket, {}, {});
            await vi.advanceTimersByTimeAsync(0);
            const client = room.clients.get('c1')!;

            rec.buffered = 500; // half the cap — under, so no eviction.
            room.send(client, 'a');
            room.broadcast('b');
            await vi.advanceTimersByTimeAsync(3000);

            expect(room.clients.has('c1')).toBe(true);
            expect(rec.closed).toBeNull();

            await room.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('never evicts a transport that always reports 0 bufferedAmount', async () => {
        vi.useFakeTimers();
        try {
            const room = await start({
                standalone: true,
                transport: stubTransport(sink),
                // cap of 0 would trip any positive buffered value — but a socket that
                // always reports 0 is never > 0, so it is never evicted for pressure.
                maxOutboundBufferBytes: 0,
                onAuth: () => auth.ok({}),
            });

            const rec = recordingSocket(subscribers());
            handlers().open('c1', rec.socket, {}, {});
            await vi.advanceTimersByTimeAsync(0);
            const client = room.clients.get('c1')!;

            rec.buffered = 0; // the "can't observe bufferedAmount" transport contract.
            room.send(client, 'a');
            room.broadcast('b');
            await vi.advanceTimersByTimeAsync(9000); // several sweeps.

            expect(room.clients.has('c1')).toBe(true);
            expect(rec.closed).toBeNull();

            await room.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
