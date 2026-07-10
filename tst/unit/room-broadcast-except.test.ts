import { beforeEach, describe, expect, it } from 'vitest';
import { unpackFrame } from '../../src/common/protocol';
import { create } from '../../src/room/index';
import type {
    ClientSocket,
    Transport,
    TransportHandlers,
    TransportListenConfig,
    TransportServer,
} from '../../src/room/transport/types';

// stub transport that captures the room's handlers and models topic pub/sub in
// memory. same shape as room-auth-identity.test.ts: publish() fans out to the
// subscribed recording sockets, so we can distinguish the pub/sub fast path
// (broadcast with no except) from the per-socket exclusion path.
type Captured = {
    handlers: TransportHandlers;
    server: TransportServer;
    subscribers: Set<RecordingSocket>;
};

type RecordingSocket = {
    socket: ClientSocket;
    userTexts: string[];
    // every framed payload the socket received directly via send() — includes both
    // the per-socket exclusion path and the pub/sub fan-out (publish calls send).
    sends: number;
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
    const userTexts: string[] = [];
    let sends = 0;
    let closed: { code: number; reason: string } | null = null;

    const socket: ClientSocket = {
        send(data) {
            sends++;
            if (typeof data === 'string') return;
            const frame = unpackFrame(data);
            if (frame.frame === 'user_text') userTexts.push(frame.text);
        },
        close(code, reason) {
            closed = { code, reason };
        },
        subscribe() {
            subscribers.add(rec);
        },
        bufferedAmount() {
            return 0;
        },
    };

    const rec: RecordingSocket = {
        socket,
        userTexts,
        get sends() {
            return sends;
        },
        get closed() {
            return closed;
        },
    };
    return rec;
}

async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
}

describe('room broadcast except', () => {
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

    it('broadcast with no except uses the pub/sub fast path — every subscriber gets it', async () => {
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => ({ ok: true, data: {} }),
        });
        await room.start();

        const a = recordingSocket(subscribers());
        const b = recordingSocket(subscribers());
        handlers().open('a', a.socket, {}, {});
        handlers().open('b', b.socket, {}, {});
        await settle();

        // reset the session-message send count noise: track userTexts specifically.
        room.broadcast('hi');

        expect(a.userTexts).toEqual(['hi']);
        expect(b.userTexts).toEqual(['hi']);
    });

    it('broadcast with except skips the excluded live client', async () => {
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => ({ ok: true, data: {} }),
        });
        await room.start();

        const a = recordingSocket(subscribers());
        const b = recordingSocket(subscribers());
        handlers().open('a', a.socket, {}, {});
        handlers().open('b', b.socket, {}, {});
        await settle();

        const clientA = room.clients.get('a')!;
        room.broadcast('everyone but a', { except: clientA });

        expect(a.userTexts).toEqual([]);
        expect(b.userTexts).toEqual(['everyone but a']);
    });

    it('broadcast with except accepts an array of excluded clients', async () => {
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => ({ ok: true, data: {} }),
        });
        await room.start();

        const a = recordingSocket(subscribers());
        const b = recordingSocket(subscribers());
        const c = recordingSocket(subscribers());
        handlers().open('a', a.socket, {}, {});
        handlers().open('b', b.socket, {}, {});
        handlers().open('c', c.socket, {}, {});
        await settle();

        const clientA = room.clients.get('a')!;
        const clientB = room.clients.get('b')!;
        room.broadcast('only c', { except: [clientA, clientB] });

        expect(a.userTexts).toEqual([]);
        expect(b.userTexts).toEqual([]);
        expect(c.userTexts).toEqual(['only c']);
    });

    it('does not buffer the message for an excluded disconnected client', async () => {
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => ({ ok: true, data: {} }),
            // hold the seat so the client stays tracked while disconnected.
            onDrop: (client) => client.allowReconnection(60_000),
        });
        await room.start();

        const a = recordingSocket(subscribers());
        const b = recordingSocket(subscribers());
        handlers().open('a', a.socket, {}, {});
        handlers().open('b', b.socket, {}, {});
        await settle();

        // a drops (non-consented) — enters reconnection window, socket null, still tracked.
        handlers().close('a', 1006);
        await settle();
        expect(room.clients.has('a')).toBe(true);

        const clientA = room.clients.get('a')!;
        // broadcast excluding the disconnected client — must not buffer for it.
        room.broadcast('while a is away', { except: clientA });

        // b is live and receives it.
        expect(b.userTexts).toEqual(['while a is away']);

        // a reconnects — the reconnect handler flushes the reliable buffer. because
        // the excluded broadcast was never buffered, a receives nothing from it.
        const a2 = recordingSocket(subscribers());
        a2.userTexts.length = 0;
        handlers().reconnect('a', a2.socket);
        await settle();

        expect(a2.userTexts).toEqual([]);
    });

    it('still buffers a normal (no-except) broadcast for a disconnected client', async () => {
        // control for the previous test: without except, a disconnected client IS
        // buffered and gets the message on reconnect.
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => ({ ok: true, data: {} }),
            onDrop: (client) => client.allowReconnection(60_000),
        });
        await room.start();

        const a = recordingSocket(subscribers());
        handlers().open('a', a.socket, {}, {});
        await settle();

        handlers().close('a', 1006);
        await settle();

        room.broadcast('buffered for a');

        const a2 = recordingSocket(subscribers());
        handlers().reconnect('a', a2.socket);
        await settle();

        expect(a2.userTexts).toEqual(['buffered for a']);
    });
});
