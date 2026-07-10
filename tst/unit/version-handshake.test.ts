import { beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, unpackFrame } from '../../src/common/protocol';
import { auth, create } from '../../src/room/index';
import type {
    ClientSocket,
    Transport,
    TransportHandlers,
    TransportListenConfig,
    TransportServer,
} from '../../src/room/transport/types';

// a stub transport that captures the room's handlers instead of opening a real
// ws server. lets us drive the upgrade -> open/reconnect flow directly and
// inspect what the room sent to a socket, all in-process.
type Captured = {
    handlers: TransportHandlers;
    server: TransportServer;
};

function stubTransport(sink: { captured?: Captured }): Transport {
    return {
        listen(handlers: TransportHandlers, _config?: TransportListenConfig): Promise<TransportServer> {
            const server: TransportServer = {
                port: 0,
                publish() {},
                close() {},
            };
            sink.captured = { handlers, server };
            return Promise.resolve(server);
        },
    };
}

// records everything the room sends to a socket, decoding protocol frames.
type RecordedClose = { code: number; reason: string };
function recordingSocket() {
    const protocolMessages: Record<string, unknown>[] = [];
    let closed: RecordedClose | null = null;

    const socket: ClientSocket = {
        send(data) {
            // the room only ever sends framed binary here — never a raw string.
            if (typeof data === 'string') throw new Error('unexpected string send');
            const frame = unpackFrame(data);
            if (frame.frame === 'protocol') protocolMessages.push(frame.message);
        },
        close(code, reason) {
            closed = { code, reason };
        },
        subscribe() {},
        bufferedAmount() {
            return 0;
        },
    };

    return {
        socket,
        protocolMessages,
        get closed() {
            return closed;
        },
    };
}

const EXPECTED = `protocol version mismatch (client none, server ${PROTOCOL_VERSION})`;

describe('protocol version handshake', () => {
    let captured: { captured?: Captured };

    beforeEach(async () => {
        captured = {};
        const room = create({
            standalone: true,
            transport: stubTransport(captured),
            onAuth: () => auth.ok({}),
        });
        await room.start();
    });

    function handlers(): TransportHandlers {
        if (!captured.captured) throw new Error('transport never captured handlers');
        return captured.captured.handlers;
    }

    it('accepts a connect whose gv matches the server version', async () => {
        const result = await handlers().upgrade(`gv=${PROTOCOL_VERSION}`);
        expect(result).not.toBeNull();
        if (!result) throw new Error('expected upgrade result');
        // a matching version leaves no mismatch marker — normal fresh connect.
        expect(result.versionMismatch).toBeUndefined();
        expect(result.reconnecting).toBeUndefined();

        // open should authenticate and hand back a session message.
        const rec = recordingSocket();
        handlers().open(result.clientId, rec.socket, {}, {});
        // let the async onAuth microtasks settle.
        await new Promise((r) => setTimeout(r, 0));

        const session = rec.protocolMessages.find((m) => m.type === 'session');
        expect(session).toBeDefined();
        expect(rec.closed).toBeNull();
    });

    it('rejects a connect with no gv param — readable auth_error then close 4000', async () => {
        const result = await handlers().upgrade('');
        if (!result) throw new Error('expected upgrade to complete so the client gets a readable error');
        expect(result.versionMismatch).toBe(EXPECTED);

        const rec = recordingSocket();
        handlers().open(result.clientId, rec.socket, {}, {}, result.versionMismatch);

        expect(rec.protocolMessages).toEqual([{ type: 'auth_error', error: EXPECTED }]);
        expect(rec.closed).toEqual({ code: 4000, reason: 'protocol version mismatch' });
    });

    it('rejects a connect with a wrong gv value', async () => {
        const wrong = PROTOCOL_VERSION + 1;
        const result = await handlers().upgrade(`gv=${wrong}`);
        if (!result) throw new Error('expected upgrade result');
        expect(result.versionMismatch).toBe(`protocol version mismatch (client ${wrong}, server ${PROTOCOL_VERSION})`);

        const rec = recordingSocket();
        handlers().open(result.clientId, rec.socket, {}, {}, result.versionMismatch);
        expect(rec.closed).toEqual({ code: 4000, reason: 'protocol version mismatch' });
    });

    it('rejects a version-mismatched reconnect too (session param present)', async () => {
        // a reconnect carries a session token — the mismatch must still be
        // caught before any session lookup, via the reconnect handler.
        const result = await handlers().upgrade('session=whatever');
        if (!result) throw new Error('expected upgrade result');
        expect(result.reconnecting).toBe(true);
        expect(result.versionMismatch).toBe(EXPECTED);

        const rec = recordingSocket();
        handlers().reconnect(result.clientId, rec.socket, result.versionMismatch);
        expect(rec.protocolMessages).toEqual([{ type: 'auth_error', error: EXPECTED }]);
        expect(rec.closed).toEqual({ code: 4000, reason: 'protocol version mismatch' });
    });
});
