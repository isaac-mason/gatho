import { beforeEach, describe, expect, it } from 'vitest';
import { frameUserMessage, unpackFrame } from '../../src/common/protocol';
import { type AuthResult, auth, create } from '../../src/room/index';
import type {
    ClientSocket,
    Transport,
    TransportHandlers,
    TransportListenConfig,
    TransportServer,
} from '../../src/room/transport/types';

// stub transport that captures the room's handlers and models topic pub/sub in
// memory, so we can drive upgrade -> open/reconnect/message/close directly and
// observe exactly what each socket receives — all in-process. mirrors the
// pattern in version-handshake.test.ts, extended with a working publish() and
// per-socket subscribe tracking so broadcast leakage is observable.
type Captured = {
    handlers: TransportHandlers;
    server: TransportServer;
    subscribers: Set<RecordingSocket>;
};

type RecordedClose = { code: number; reason: string };

type RecordingSocket = {
    socket: ClientSocket;
    protocolMessages: Record<string, unknown>[];
    userTexts: string[];
    readonly closed: RecordedClose | null;
    readonly subscribed: boolean;
};

function stubTransport(sink: { captured?: Captured }): Transport {
    const subscribers = new Set<RecordingSocket>();
    return {
        listen(handlers: TransportHandlers, _config?: TransportListenConfig): Promise<TransportServer> {
            const server: TransportServer = {
                port: 0,
                publish(_topic, data) {
                    // deliver to every currently-subscribed recording socket.
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
    const protocolMessages: Record<string, unknown>[] = [];
    const userTexts: string[] = [];
    let closed: RecordedClose | null = null;
    let subscribed = false;

    const socket: ClientSocket = {
        send(data) {
            if (typeof data === 'string') throw new Error('unexpected string send');
            const frame = unpackFrame(data);
            if (frame.frame === 'protocol') protocolMessages.push(frame.message);
            else if (frame.frame === 'user_text') userTexts.push(frame.text);
        },
        close(code, reason) {
            closed = { code, reason };
        },
        subscribe() {
            subscribed = true;
            subscribers.add(rec);
        },
        bufferedAmount() {
            return 0;
        },
    };

    const rec: RecordingSocket = {
        socket,
        protocolMessages,
        userTexts,
        get closed() {
            return closed;
        },
        get subscribed() {
            return subscribed;
        },
    };
    return rec;
}

// deliver a user text frame to the room's message handler, framed the same way
// the client would frame it.
function sendText(handlers: TransportHandlers, clientId: string, text: string): void {
    const framed = frameUserMessage(text);
    handlers.message(
        clientId,
        framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
        false,
    );
}

async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
}

describe('room auth + socket identity', () => {
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

    it('rejects a duplicate connection for a clientId that already has a live socket', async () => {
        const messages: string[] = [];
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => auth.ok({}),
            onMessage: (_c, msg) => {
                if (typeof msg === 'string') messages.push(msg);
            },
        });
        await room.start();

        // first connection authenticates and is tracked.
        const a = recordingSocket(subscribers());
        handlers().open('c1', a.socket, {}, {});
        await settle();
        expect(a.protocolMessages.find((m) => m.type === 'session')).toBeDefined();
        expect(a.closed).toBeNull();

        // second connection for the same clientId (same seat jwt reused) is rejected
        // before onAuth, with a readable error and 4000 close.
        const b = recordingSocket(subscribers());
        handlers().open('c1', b.socket, {}, {});
        await settle();
        expect(b.protocolMessages).toEqual([{ type: 'auth_error', error: 'seat already in use' }]);
        expect(b.closed).toEqual({ code: 4000, reason: 'seat already in use' });
        // the duplicate never subscribed to broadcasts.
        expect(b.subscribed).toBe(false);

        // the first client is untouched: still a session recipient, not closed, still
        // subscribed, still receiving room sends and broadcasts, and its inbound
        // messages still flow (its close handler was never disturbed).
        expect(a.closed).toBeNull();
        expect(a.subscribed).toBe(true);
        const client = room.clients.get('c1')!;
        client.send('direct');
        expect(a.userTexts).toContain('direct');
        room.broadcast('to-all');
        expect(a.userTexts).toContain('to-all');
        sendText(handlers(), 'c1', 'inbound');
        await settle();
        expect(messages).toEqual(['inbound']);
    });

    it('rejects a fresh-jwt open for a clientId in the reconnection window (socket === null)', async () => {
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => auth.ok({}),
            onDrop: (client) => {
                client.allowReconnection(60_000);
            },
        });
        await room.start();

        // establish, then drop (non-consented) so the seat is held with socket === null.
        const a = recordingSocket(subscribers());
        handlers().open('c1', a.socket, {}, {});
        await settle();
        handlers().close('c1', 1006);
        await settle();
        expect(room.clients.has('c1')).toBe(true);

        // a fresh jwt open() for the same clientId must be rejected — resumption goes
        // through the session-token reconnect path, not a re-redeemed jwt.
        const b = recordingSocket(subscribers());
        handlers().open('c1', b.socket, {}, {});
        await settle();
        expect(b.protocolMessages).toEqual([{ type: 'auth_error', error: 'seat already in use' }]);
        expect(b.closed).toEqual({ code: 4000, reason: 'seat already in use' });
        // the held seat is undisturbed — still exactly one tracked client.
        expect(room.clients.count()).toBe(1);
    });

    it('does not subscribe a client to broadcasts until onAuth resolves ok', async () => {
        let releaseAuth: (() => void) | null = null;
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () =>
                new Promise<AuthResult<Record<string, never>>>((resolve) => {
                    releaseAuth = () => resolve(auth.ok({}));
                }),
        });
        await room.start();

        const rec = recordingSocket(subscribers());
        handlers().open('c1', rec.socket, {}, {});
        await settle();

        // auth is still pending — a broadcast now must NOT reach the socket.
        room.broadcast('during-auth');
        expect(rec.userTexts).toEqual([]);
        expect(rec.subscribed).toBe(false);

        // resolve auth ok — client is now subscribed and gets subsequent broadcasts.
        releaseAuth!();
        await settle();
        expect(rec.subscribed).toBe(true);
        room.broadcast('after-auth');
        expect(rec.userTexts).toEqual(['after-auth']);
    });

    it('never subscribes a client whose onAuth fails', async () => {
        let releaseAuth: (() => void) | null = null;
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () =>
                new Promise<AuthResult<Record<string, never>>>((resolve) => {
                    releaseAuth = () => resolve(auth.fail('nope'));
                }),
        });
        await room.start();

        const rec = recordingSocket(subscribers());
        handlers().open('c1', rec.socket, {}, {});
        await settle();
        room.broadcast('during-auth');
        expect(rec.userTexts).toEqual([]);

        releaseAuth!();
        await settle();
        expect(rec.subscribed).toBe(false);
        expect(rec.closed).toEqual({ code: 4000, reason: 'auth rejected' });
        // a broadcast after the failure still never reaches the rejected socket.
        room.broadcast('after-fail');
        expect(rec.userTexts).toEqual([]);
    });

    it('does not evict a client that reconnects while onDrop awaits', async () => {
        let releaseDrop: (() => void) | null = null;
        let leaveCount = 0;
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => auth.ok({}),
            onDrop: () =>
                new Promise((resolve) => {
                    releaseDrop = () => resolve();
                }),
            onLeave: () => {
                leaveCount++;
            },
        });
        await room.start();

        // to reconnect we need a valid session token — capture it from the session msg.
        const a = recordingSocket(subscribers());
        handlers().open('c1', a.socket, {}, {});
        await settle();

        // drop non-consented — onDrop starts awaiting (does not call allowReconnection).
        handlers().close('c1', 1006);
        await settle();
        expect(room.clients.has('c1')).toBe(true);

        // while onDrop awaits, the client reconnects via the reconnect handler (swaps
        // in a live socket).
        const b = recordingSocket(subscribers());
        handlers().reconnect('c1', b.socket);
        await settle();

        // now onDrop resolves WITHOUT allowReconnection. the client must NOT be evicted
        // because it reconnected (socket !== null).
        releaseDrop!();
        await settle();
        expect(room.clients.has('c1')).toBe(true);
        expect(leaveCount).toBe(0);
    });

    it('a client evicted after onDrop (no reconnect) fires onLeave exactly once', async () => {
        let releaseDrop: (() => void) | null = null;
        let leaveCount = 0;
        const room = create({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => auth.ok({}),
            onDrop: () =>
                new Promise((resolve) => {
                    releaseDrop = () => resolve();
                }),
            onLeave: () => {
                leaveCount++;
            },
        });
        await room.start();

        const a = recordingSocket(subscribers());
        handlers().open('c1', a.socket, {}, {});
        await settle();
        handlers().close('c1', 1006);
        await settle();

        // no reconnect — onDrop resolves without allowReconnection -> evict.
        releaseDrop!();
        await settle();
        expect(room.clients.has('c1')).toBe(false);
        expect(leaveCount).toBe(1);
    });
});
