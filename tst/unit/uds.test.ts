import { describe, it, expect } from 'vitest';
import { ipcCodec, createFrameReader, type RoomMessage } from '../../common/uds';

describe('uds ipc codec', () => {
    // round-trip every message variant through pack/unpack
    const variants: RoomMessage[] = [
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
            clientIds: ['abc-123', 'def-456'],
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
            clientIds: [],
        },
        { type: 'client-connected', clientId: 'user-abc' },
        { type: 'client-disconnected', clientId: 'user-abc' },
        { type: 'error', message: 'something went wrong' },
        { type: 'stopped' },
    ];

    for (const msg of variants) {
        it(`round-trips ${msg.type}`, () => {
            const packed = ipcCodec.pack(msg);
            expect(packed).toBeInstanceOf(Uint8Array);
            expect(packed.byteLength).toBeGreaterThan(0);

            const unpacked = ipcCodec.unpack(packed);
            expect(unpacked).toEqual(msg);
        });
    }

    it('heartbeat with many client ids', () => {
        const clientIds = Array.from({ length: 200 }, (_, i) => `client-${i}`);
        const msg: RoomMessage = {
            type: 'heartbeat',
            timestamp: 1713300000000,
            metrics: {
                memoryRss: 1e9,
                memoryHeapUsed: 5e8,
                memoryHeapTotal: 6e8,
                cpuUser: 1e7,
                cpuSystem: 2e6,
            },
            clientIds,
        };
        const unpacked = ipcCodec.unpack(ipcCodec.pack(msg));
        expect(unpacked).toEqual(msg);
        expect((unpacked as { clientIds: string[] }).clientIds).toHaveLength(200);
    });

    it('port uses uint16 — max value 65535', () => {
        const msg: RoomMessage = { type: 'ready', port: 65535 };
        const unpacked = ipcCodec.unpack(ipcCodec.pack(msg));
        expect((unpacked as { port: number }).port).toBe(65535);
    });

    it('timestamp preserves millisecond precision via float64', () => {
        const ts = 1713300000123.456;
        const msg: RoomMessage = {
            type: 'heartbeat',
            timestamp: ts,
            metrics: { memoryRss: 0, memoryHeapUsed: 0, memoryHeapTotal: 0, cpuUser: 0, cpuSystem: 0 },
            clientIds: [],
        };
        const unpacked = ipcCodec.unpack(ipcCodec.pack(msg));
        expect((unpacked as { timestamp: number }).timestamp).toBe(ts);
    });
});

describe('createFrameReader', () => {
    // helper: build a raw length-prefixed frame from a RoomMessage
    function buildFrame(msg: RoomMessage): Buffer {
        const payload = ipcCodec.pack(msg);
        const frame = Buffer.alloc(4 + payload.byteLength);
        frame.writeUInt32BE(payload.byteLength, 0);
        frame.set(payload, 4);
        return frame;
    }

    it('delivers a single complete frame', () => {
        const received: RoomMessage[] = [];
        const reader = createFrameReader((msg) => received.push(msg));

        const msg: RoomMessage = { type: 'ready', port: 3000 };
        reader.push(buildFrame(msg));

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(msg);
    });

    it('delivers multiple frames from a single chunk', () => {
        const received: RoomMessage[] = [];
        const reader = createFrameReader((msg) => received.push(msg));

        const msgs: RoomMessage[] = [
            { type: 'ready', port: 3000 },
            { type: 'client-connected', clientId: 'a' },
            { type: 'stopped' },
        ];

        const combined = Buffer.concat(msgs.map(buildFrame));
        reader.push(combined);

        expect(received).toHaveLength(3);
        for (let i = 0; i < msgs.length; i++) {
            expect(received[i]).toEqual(msgs[i]);
        }
    });

    it('handles partial frames across multiple pushes', () => {
        const received: RoomMessage[] = [];
        const reader = createFrameReader((msg) => received.push(msg));

        const msg: RoomMessage = { type: 'client-connected', clientId: 'test-user-123' };
        const frame = buildFrame(msg);

        // split at an arbitrary point in the middle
        const mid = Math.floor(frame.byteLength / 2);
        reader.push(frame.subarray(0, mid));
        expect(received).toHaveLength(0);

        reader.push(frame.subarray(mid));
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(msg);
    });

    it('handles byte-at-a-time delivery', () => {
        const received: RoomMessage[] = [];
        const reader = createFrameReader((msg) => received.push(msg));

        const msg: RoomMessage = { type: 'stopped' };
        const frame = buildFrame(msg);

        for (let i = 0; i < frame.byteLength; i++) {
            reader.push(frame.subarray(i, i + 1));
        }

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(msg);
    });

    it('handles split across header boundary', () => {
        const received: RoomMessage[] = [];
        const reader = createFrameReader((msg) => received.push(msg));

        const msg: RoomMessage = { type: 'error', message: 'uh oh' };
        const frame = buildFrame(msg);

        // push only 2 of 4 header bytes first
        reader.push(frame.subarray(0, 2));
        expect(received).toHaveLength(0);

        reader.push(frame.subarray(2));
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(msg);
    });

    it('interleaves partial and complete frames', () => {
        const received: RoomMessage[] = [];
        const reader = createFrameReader((msg) => received.push(msg));

        const msg1: RoomMessage = { type: 'ready', port: 9000 };
        const msg2: RoomMessage = { type: 'client-disconnected', clientId: 'x' };
        const frame1 = buildFrame(msg1);
        const frame2 = buildFrame(msg2);

        // send tail of frame1 + all of frame2 in one chunk
        const mid = Math.floor(frame1.byteLength / 2);
        reader.push(frame1.subarray(0, mid));
        expect(received).toHaveLength(0);

        reader.push(Buffer.concat([frame1.subarray(mid), frame2]));
        expect(received).toHaveLength(2);
        expect(received[0]).toEqual(msg1);
        expect(received[1]).toEqual(msg2);
    });
});
