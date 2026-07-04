import { describe, it, expect } from 'vitest';
import { notifyCodec, createFrameReader, type NotifyMessage } from '../../src/common/notify-protocol';

describe('notify codec', () => {
    // round-trip every message variant through pack/unpack
    const variants: NotifyMessage[] = [
        { type: 'ready', port: 8080 },
        { type: 'ready', port: 0 },
        { type: 'ready', port: 65535 },
        {
            type: 'heartbeat',
            timestamp: 1713300000000,
            metrics: {
                memoryRss: 104857600,
                memoryHeapUsed: 52428800,
                memoryHeapTotal: 67108864,
                cpuUser: 1500000,
                cpuSystem: 300000,
            },
            clients: [
                { clientId: 'abc-123', tags: { region: 'us-east' } },
                { clientId: 'def-456', tags: {} },
            ],
        },
        {
            type: 'heartbeat',
            timestamp: Date.now(),
            metrics: {
                memoryRss: 0,
                memoryHeapUsed: 0,
                memoryHeapTotal: 0,
                cpuUser: 0,
                cpuSystem: 0,
            },
            clients: [],
        },
        // metrics omitted — a room runtime without process metrics (e.g. a
        // workerd isolate) reports a heartbeat with no `metrics` value.
        {
            type: 'heartbeat',
            timestamp: 1713300000000,
            metrics: undefined,
            clients: [{ clientId: 'no-metrics', tags: {} }],
        },
        { type: 'client-connected', clientId: 'user-abc', roomId: 'room-1', tags: { team: 'red' } },
        { type: 'client-connected', clientId: 'user-def', roomId: 'room-2', tags: {} },
        { type: 'client-disconnected', clientId: 'user-abc' },
        { type: 'error', message: 'something went wrong' },
        { type: 'stopped' },
    ];

    for (const msg of variants) {
        it(`round-trips ${msg.type}`, () => {
            const packed = notifyCodec.pack(msg);
            expect(packed).toBeInstanceOf(Uint8Array);
            expect(packed.byteLength).toBeGreaterThan(0);

            const unpacked = notifyCodec.unpack(packed);
            expect(unpacked).toEqual(msg);
        });
    }

    it('heartbeat round-trips with metrics omitted (undefined)', () => {
        const msg: NotifyMessage = {
            type: 'heartbeat',
            timestamp: 1713300000000,
            metrics: undefined,
            clients: [{ clientId: 'abc', tags: {} }],
        };
        const unpacked = notifyCodec.unpack(notifyCodec.pack(msg)) as { metrics?: unknown };
        expect(unpacked).toEqual(msg);
        expect(unpacked.metrics).toBeUndefined();
    });

    it('heartbeat with many clients', () => {
        const clients = Array.from({ length: 200 }, (_, i) => ({
            clientId: `client-${i}`,
            tags: { idx: String(i) },
        }));
        const msg: NotifyMessage = {
            type: 'heartbeat',
            timestamp: 1713300000000,
            metrics: {
                memoryRss: 1e9,
                memoryHeapUsed: 5e8,
                memoryHeapTotal: 6e8,
                cpuUser: 1e7,
                cpuSystem: 2e6,
            },
            clients,
        };
        const unpacked = notifyCodec.unpack(notifyCodec.pack(msg));
        expect(unpacked).toEqual(msg);
        expect((unpacked as { clients: unknown[] }).clients).toHaveLength(200);
    });

    it('port uses uint16 — max value 65535', () => {
        const msg: NotifyMessage = { type: 'ready', port: 65535 };
        const unpacked = notifyCodec.unpack(notifyCodec.pack(msg));
        expect((unpacked as { port: number }).port).toBe(65535);
    });

    it('timestamp preserves millisecond precision via float64', () => {
        const ts = 1713300000123.456;
        const msg: NotifyMessage = {
            type: 'heartbeat',
            timestamp: ts,
            metrics: { memoryRss: 0, memoryHeapUsed: 0, memoryHeapTotal: 0, cpuUser: 0, cpuSystem: 0 },
            clients: [],
        };
        const unpacked = notifyCodec.unpack(notifyCodec.pack(msg));
        expect((unpacked as { timestamp: number }).timestamp).toBe(ts);
    });
});

describe('createFrameReader', () => {
    // helper: build a raw length-prefixed frame from a NotifyMessage
    function buildFrame(msg: NotifyMessage): Buffer {
        const payload = notifyCodec.pack(msg);
        const frame = Buffer.alloc(4 + payload.byteLength);
        frame.writeUInt32BE(payload.byteLength, 0);
        frame.set(payload, 4);
        return frame;
    }

    it('delivers a single complete frame', () => {
        const received: NotifyMessage[] = [];
        const push = createFrameReader((msg) => received.push(msg));

        const msg: NotifyMessage = { type: 'ready', port: 3000 };
        push(buildFrame(msg));

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(msg);
    });

    it('delivers multiple frames from a single chunk', () => {
        const received: NotifyMessage[] = [];
        const push = createFrameReader((msg) => received.push(msg));

        const msgs: NotifyMessage[] = [
            { type: 'ready', port: 3000 },
            { type: 'client-connected', clientId: 'a', roomId: 'room-1', tags: {} },
            { type: 'stopped' },
        ];

        const combined = Buffer.concat(msgs.map(buildFrame));
        push(combined);

        expect(received).toHaveLength(3);
        for (let i = 0; i < msgs.length; i++) {
            expect(received[i]).toEqual(msgs[i]);
        }
    });

    it('handles partial frames across multiple pushes', () => {
        const received: NotifyMessage[] = [];
        const push = createFrameReader((msg) => received.push(msg));

        const msg: NotifyMessage = { type: 'client-connected', clientId: 'test-user-123', roomId: 'room-1', tags: {} };
        const frame = buildFrame(msg);

        // split at an arbitrary point in the middle
        const mid = Math.floor(frame.byteLength / 2);
        push(frame.subarray(0, mid));
        expect(received).toHaveLength(0);

        push(frame.subarray(mid));
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(msg);
    });

    it('handles byte-at-a-time delivery', () => {
        const received: NotifyMessage[] = [];
        const push = createFrameReader((msg) => received.push(msg));

        const msg: NotifyMessage = { type: 'stopped' };
        const frame = buildFrame(msg);

        for (let i = 0; i < frame.byteLength; i++) {
            push(frame.subarray(i, i + 1));
        }

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(msg);
    });

    it('handles split across header boundary', () => {
        const received: NotifyMessage[] = [];
        const push = createFrameReader((msg) => received.push(msg));

        const msg: NotifyMessage = { type: 'error', message: 'uh oh' };
        const frame = buildFrame(msg);

        // push only 2 of 4 header bytes first
        push(frame.subarray(0, 2));
        expect(received).toHaveLength(0);

        push(frame.subarray(2));
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(msg);
    });

    it('interleaves partial and complete frames', () => {
        const received: NotifyMessage[] = [];
        const push = createFrameReader((msg) => received.push(msg));

        const msg1: NotifyMessage = { type: 'ready', port: 9000 };
        const msg2: NotifyMessage = { type: 'client-disconnected', clientId: 'x' };
        const frame1 = buildFrame(msg1);
        const frame2 = buildFrame(msg2);

        // send tail of frame1 + all of frame2 in one chunk
        const mid = Math.floor(frame1.byteLength / 2);
        push(frame1.subarray(0, mid));
        expect(received).toHaveLength(0);

        push(Buffer.concat([frame1.subarray(mid), frame2]));
        expect(received).toHaveLength(2);
        expect(received[0]).toEqual(msg1);
        expect(received[1]).toEqual(msg2);
    });
});
