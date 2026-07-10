import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloseCause } from '../../src/client/index';
import { packProtocol, unpackFrame } from '../../src/common/protocol';

// a mock WebSocket the tests drive by hand. installed as globalThis.WebSocket so
// the client (which does `new WebSocket(url)`) picks it up. supports firing open,
// delivering protocol frames, and firing close.
class MockWebSocket {
    static OPEN = 1;
    static instances: MockWebSocket[] = [];

    url: string;
    readyState = 0;
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    sent: unknown[] = [];

    constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    fireOpen(): void {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
    }

    deliverProtocol(msg: Parameters<typeof packProtocol>[0]): void {
        const framed = packProtocol(msg);
        const ab = framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer;
        this.onmessage?.({ data: ab });
    }

    fireClose(code: number, reason = ''): void {
        this.readyState = 3;
        this.onclose?.({ code, reason });
    }

    send(data: unknown): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 3;
    }
}

// decode a sent frame back into the user text it carried (user messages are
// framed via frameUserMessage). returns null for non-user frames.
function sentText(data: unknown): string | null {
    if (!(data instanceof Uint8Array)) return null;
    const frame = unpackFrame(data);
    return frame.frame === 'user_text' ? frame.text : null;
}

describe('client connecting buffer + open semantics', () => {
    let original: typeof globalThis.WebSocket;

    beforeEach(() => {
        original = globalThis.WebSocket;
        MockWebSocket.instances = [];
        globalThis.WebSocket = MockWebSocket as unknown as typeof globalThis.WebSocket;
    });

    afterEach(() => {
        globalThis.WebSocket = original;
        vi.useRealTimers();
    });

    it('buffers reliable sends during connecting and flushes them in order before open fires', async () => {
        const { connect } = await import('../../src/client/index');
        // events observed, so we can assert flush-before-open ordering.
        const events: string[] = [];
        const room = connect('ws://localhost:9001', {
            onOpen: () => events.push('open'),
        });
        const sock = MockWebSocket.instances[0];

        // ws is connected but no session yet — still connecting.
        sock.fireOpen();
        expect(room.state).toBe('connecting');

        // reliable sends while connecting are buffered, not sent.
        room.send('a');
        room.send('b');
        room.send('c');
        expect(sock.sent).toHaveLength(0);

        // session arrives — transition to open, buffer flushed in order, then open.
        sock.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });

        expect(room.state).toBe('open');
        const texts = sock.sent.map(sentText);
        expect(texts).toEqual(['a', 'b', 'c']);
        expect(events).toEqual(['open']);
    });

    it('flushes the connecting buffer before emitting open', async () => {
        const { connect } = await import('../../src/client/index');
        // at the moment open fires, the buffered message must already be sent.
        let sentAtOpen = 0;
        const room = connect('ws://localhost:9001', {
            onOpen: () => {
                sentAtOpen = sock.sent.length;
            },
        });
        const sock = MockWebSocket.instances[0];

        sock.fireOpen();
        room.send('queued');

        sock.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });
        expect(sentAtOpen).toBe(1);
    });

    it('drops unreliable sends during connecting', async () => {
        const { connect } = await import('../../src/client/index');
        const room = connect('ws://localhost:9001');
        const sock = MockWebSocket.instances[0];

        sock.fireOpen();
        room.send('u', { reliable: false });
        expect(sock.sent).toHaveLength(0);

        // after session, the dropped unreliable message is NOT resurrected.
        sock.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });
        expect(sock.sent).toHaveLength(0);
    });

    it('does not fire open on raw ws open — only on session receipt', async () => {
        const { connect } = await import('../../src/client/index');
        let opened = false;
        const room = connect('ws://localhost:9001', {
            onOpen: () => {
                opened = true;
            },
        });
        const sock = MockWebSocket.instances[0];

        sock.fireOpen();
        expect(opened).toBe(false);
        expect(room.state).toBe('connecting');

        sock.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });
        expect(opened).toBe(true);
        expect(room.state).toBe('open');
    });

    it('auth_error on initial connect emits authError then closes with cause auth, never opening', async () => {
        const { connect } = await import('../../src/client/index');
        let opened = false;
        let authError: unknown = null;
        let closeInfo: { code: number; reason: string; cause: CloseCause } | null = null;
        const room = connect('ws://localhost:9001', {
            onOpen: () => {
                opened = true;
            },
            onAuthError: (err) => {
                authError = err;
            },
            onClose: (info) => {
                closeInfo = info;
            },
        });
        const sock = MockWebSocket.instances[0];

        sock.fireOpen();
        // buffer a reliable message during connecting — it must be discarded on close.
        room.send('should-never-send');

        sock.deliverProtocol({ type: 'auth_error', error: 'not allowed' });
        expect(authError).toBe('not allowed');
        expect(opened).toBe(false);

        // server follows auth_error with a 4000 close.
        sock.fireClose(4000, 'auth failed');
        expect(closeInfo).toEqual({ code: 4000, reason: 'auth failed', cause: 'auth' });
        expect(opened).toBe(false);
        // the buffered message was discarded, not flushed.
        expect(sock.sent.map(sentText)).not.toContain('should-never-send');
    });

    it('initial ws closing before session yields cause initial-connect-failed', async () => {
        const { connect } = await import('../../src/client/index');
        let closeInfo: { cause: CloseCause } | null = null;
        connect('ws://localhost:9001', {
            onClose: (info) => {
                closeInfo = info;
            },
        });
        const sock = MockWebSocket.instances[0];

        sock.fireOpen();
        sock.fireClose(1006, 'gone');
        expect(closeInfo!.cause).toBe('initial-connect-failed');
    });

    it('user close() during open yields cause consented', async () => {
        const { connect } = await import('../../src/client/index');
        let closeInfo: { code: number; cause: CloseCause } | null = null;
        const room = connect('ws://localhost:9001', {
            onClose: (info) => {
                closeInfo = info;
            },
        });
        const sock = MockWebSocket.instances[0];

        sock.fireOpen();
        sock.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });
        expect(room.state).toBe('open');

        // close() sends leave + closes with 4000; the mock's close does not auto-fire
        // onclose, so simulate the server/socket close afterward.
        room.close();
        sock.fireClose(4000, 'consented leave');
        expect(closeInfo).toEqual({ code: 4000, reason: 'consented leave', cause: 'consented' });
    });

    it('server-initiated 4000 on an open connection yields cause server', async () => {
        const { connect } = await import('../../src/client/index');
        let closeInfo: { cause: CloseCause } | null = null;
        connect('ws://localhost:9001', {
            onClose: (info) => {
                closeInfo = info;
            },
        });
        const sock = MockWebSocket.instances[0];

        sock.fireOpen();
        sock.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });

        // no close() call — server evicts us with 4000.
        sock.fireClose(4000, 'evicted');
        expect(closeInfo!.cause).toBe('server');
    });

    it('outbound buffer overflow during connecting yields cause buffer-overflow', async () => {
        const { connect } = await import('../../src/client/index');
        let closeInfo: { cause: CloseCause } | null = null;
        const room = connect('ws://localhost:9001', {
            onClose: (info) => {
                closeInfo = info;
            },
        });
        const sock = MockWebSocket.instances[0];

        sock.fireOpen();
        // byte size for a string is length*2. push > 1mb while connecting.
        const big = 'x'.repeat(600_000); // 1.2mb
        room.send(big);
        expect(closeInfo!.cause).toBe('buffer-overflow');
        expect(room.state).toBe('closed');
    });

    it('reconnect attempt cap exhaustion yields cause reconnect-failed', async () => {
        vi.useFakeTimers();
        const { connect } = await import('../../src/client/index');
        let closeInfo: { cause: CloseCause; code: number } | null = null;
        const room = connect('ws://localhost:9001', {
            onClose: (info) => {
                closeInfo = info;
            },
        });

        // establish an authenticated connection so we have a session token.
        const first = MockWebSocket.instances[0];
        first.fireOpen();
        first.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });
        expect(room.state).toBe('open');

        // drop unexpectedly (non-4000) — enters reconnecting.
        first.fireClose(1006, 'dropped');
        expect(room.state).toBe('reconnecting');

        // drive the backoff loop: each new ws immediately closes, failing the attempt.
        // the cap is 10 attempts; after the 10th failed attempt, give up.
        for (let i = 0; i < 20; i++) {
            if (room.state === 'closed') break;
            // advance past the backoff delay to spawn the next attempt ws.
            await vi.advanceTimersByTimeAsync(11_000);
            const sock = MockWebSocket.instances.at(-1);
            if (sock && room.state === 'reconnecting') {
                // fail this attempt immediately.
                sock.fireClose(1006, 'still dead');
            }
        }

        expect(room.state).toBe('closed');
        expect(closeInfo!.cause).toBe('reconnect-failed');
    });

    it('resets the reconnect counter on a successful reconnect', async () => {
        vi.useFakeTimers();
        const { connect } = await import('../../src/client/index');
        const room = connect('ws://localhost:9001');

        const first = MockWebSocket.instances[0];
        first.fireOpen();
        first.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });
        first.fireClose(1006, 'dropped');
        expect(room.state).toBe('reconnecting');

        // fail a few attempts.
        for (let i = 0; i < 3; i++) {
            await vi.advanceTimersByTimeAsync(11_000);
            const sock = MockWebSocket.instances.at(-1)!;
            sock.fireClose(1006, 'dead');
        }

        // now succeed: next attempt's ws opens and gets a session.
        await vi.advanceTimersByTimeAsync(11_000);
        const good = MockWebSocket.instances.at(-1)!;
        good.fireOpen();
        good.deliverProtocol({ type: 'session', token: 'tok2', clientId: 'c1' });
        expect(room.state).toBe('open');

        // drop again — because the counter reset, we get a full fresh run of
        // attempts rather than giving up immediately.
        good.fireClose(1006, 'dropped again');
        expect(room.state).toBe('reconnecting');
        // one more failed attempt should still be reconnecting (not exhausted).
        await vi.advanceTimersByTimeAsync(11_000);
        const nxt = MockWebSocket.instances.at(-1)!;
        expect(room.state).toBe('reconnecting');
        nxt.fireClose(1006, 'dead');
        expect(room.state).toBe('reconnecting');
    });

    it('rejected session on reconnect yields cause session', async () => {
        vi.useFakeTimers();
        const { connect } = await import('../../src/client/index');
        let closeInfo: { cause: CloseCause } | null = null;
        const room = connect('ws://localhost:9001', {
            onClose: (info) => {
                closeInfo = info;
            },
        });

        const first = MockWebSocket.instances[0];
        first.fireOpen();
        first.deliverProtocol({ type: 'session', token: 'tok', clientId: 'c1' });
        first.fireClose(1006, 'dropped');

        await vi.advanceTimersByTimeAsync(11_000);
        const attempt = MockWebSocket.instances.at(-1)!;
        attempt.fireOpen();
        // server rejects the session on reconnect.
        attempt.deliverProtocol({ type: 'auth_error', error: 'invalid session' });

        expect(room.state).toBe('closed');
        expect(closeInfo!.cause).toBe('session');
    });
});
