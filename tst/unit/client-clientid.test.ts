import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packProtocol, PROTOCOL_VERSION } from '../../src/common/protocol';

// a minimal mock WebSocket that records the url it was constructed with and
// lets the test drive open + inbound messages. installed as globalThis.WebSocket
// so the client (which does `new WebSocket(url)`) picks it up.
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

    // simulate the socket connecting.
    fireOpen(): void {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
    }

    // deliver a protocol frame to the client as an ArrayBuffer.
    deliverProtocol(msg: Parameters<typeof packProtocol>[0]): void {
        const framed = packProtocol(msg);
        const ab = framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer;
        this.onmessage?.({ data: ab });
    }

    send(data: unknown): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 3;
    }
}

describe('client clientId exposure', () => {
    let original: typeof globalThis.WebSocket;

    beforeEach(() => {
        original = globalThis.WebSocket;
        MockWebSocket.instances = [];
        // the client only uses `new WebSocket()` and `WebSocket.OPEN`.
        globalThis.WebSocket = MockWebSocket as unknown as typeof globalThis.WebSocket;
    });

    afterEach(() => {
        globalThis.WebSocket = original;
    });

    it('stamps gv on the initial connect url', async () => {
        const { connect } = await import('../../src/client/index');
        connect('ws://localhost:9001?token=abc');
        expect(MockWebSocket.instances).toHaveLength(1);
        expect(MockWebSocket.instances[0].url).toBe(`ws://localhost:9001?token=abc&gv=${PROTOCOL_VERSION}`);
    });

    it('starts with clientId null and learns it from the session message', async () => {
        const { connect } = await import('../../src/client/index');
        const room = connect('ws://localhost:9001');

        // before any session message, the client does not know its id.
        expect(room.clientId).toBeNull();

        const sock = MockWebSocket.instances[0];
        sock.fireOpen();
        expect(room.clientId).toBeNull();

        sock.deliverProtocol({ type: 'session', token: 'tok', clientId: 'client-xyz' });
        expect(room.clientId).toBe('client-xyz');
    });
});
