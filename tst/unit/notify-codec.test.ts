import { describe, expect, it } from 'vitest';
import {
    createFrameReader,
    encodeNotifyFrame,
    encodeRawFrame,
    type HeartbeatMessage,
    type NotifyMessage,
    notifyCodec,
} from '../../src/common/notify-protocol';

const metrics = {
    memoryRss: 123456789,
    memoryHeapUsed: 45678901,
    memoryHeapTotal: 67890123,
    cpuUser: 1234567.5,
    cpuSystem: 0.25,
};

function heartbeat(clients: HeartbeatMessage['clients'], withMetrics = true, timestamp = 1713300000123.456): NotifyMessage {
    return { type: 'heartbeat', timestamp, metrics: withMetrics ? metrics : undefined, clients };
}

function roundTrip(msg: NotifyMessage): NotifyMessage {
    return notifyCodec.unpack(notifyCodec.pack(msg));
}

function manyClients(count: number, tagCount: number): HeartbeatMessage['clients'] {
    return Array.from({ length: count }, (_, i) => ({
        clientId: `0b6f2c9e-4d1a-4f7e-9a3b-${String(i).padStart(12, '0')}`,
        tags: Object.fromEntries(Array.from({ length: tagCount }, (_, t) => [`tag${t}`, `value-${i}-${t}`])),
    }));
}

describe('notify codec', () => {
    describe('round trips', () => {
        it('ready at the uint16 bounds', () => {
            for (const port of [0, 1, 255, 256, 8080, 65534, 65535]) {
                expect(roundTrip({ type: 'ready', port })).toEqual({ type: 'ready', port });
            }
        });

        it('stopped', () => {
            expect(roundTrip({ type: 'stopped' })).toEqual({ type: 'stopped' });
        });

        it('client-disconnected and error with awkward strings', () => {
            for (const text of ['', 'abc', 'héllo', '日本', '😀🎉', '﻿bom', 'x'.repeat(200)]) {
                expect(roundTrip({ type: 'client-disconnected', clientId: text })).toEqual({
                    type: 'client-disconnected',
                    clientId: text,
                });
                expect(roundTrip({ type: 'error', message: text })).toEqual({ type: 'error', message: text });
            }
        });

        it('client-connected with empty and populated tags', () => {
            const empty: NotifyMessage = { type: 'client-connected', clientId: '', roomId: '', tags: {} };
            expect(roundTrip(empty)).toEqual(empty);
            const populated: NotifyMessage = {
                type: 'client-connected',
                clientId: 'cé',
                roomId: 'room-😀',
                tags: { team: 'red', '': '', 日: '本', long: 'v'.repeat(500) },
            };
            expect(roundTrip(populated)).toEqual(populated);
        });

        it('heartbeat with metrics present and absent', () => {
            const clients = manyClients(3, 2);
            expect(roundTrip(heartbeat(clients, true))).toEqual(heartbeat(clients, true));
            const decoded = roundTrip(heartbeat(clients, false)) as HeartbeatMessage;
            expect(decoded).toEqual(heartbeat(clients, false));
            expect(decoded.metrics).toBeUndefined();
        });

        it('heartbeat with empty, single and large client lists', () => {
            for (const count of [0, 1, 2, 127, 128, 129, 200, 2000]) {
                const msg = heartbeat(manyClients(count, 3));
                expect(roundTrip(msg)).toEqual(msg);
            }
        });

        it('heartbeat clients with empty tag records', () => {
            const msg = heartbeat([
                { clientId: 'a', tags: {} },
                { clientId: '', tags: {} },
            ]);
            expect(roundTrip(msg)).toEqual(msg);
        });

        it('tag records that need a multi byte entry count', () => {
            for (const count of [127, 128, 129, 300, 16383, 16384, 20000]) {
                const tags = Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, `v${i}`]));
                const msg: NotifyMessage = { type: 'client-connected', clientId: 'c', roomId: 'r', tags };
                const decoded = roundTrip(msg) as Extract<NotifyMessage, { type: 'client-connected' }>;
                expect(Object.keys(decoded.tags)).toHaveLength(count);
                expect(decoded).toEqual(msg);
            }
        });

        it('a record in a heartbeat that needs a multi byte count keeps the entries after it', () => {
            const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, `v${i}`]));
            const msg = heartbeat([
                { clientId: 'first', tags: { a: 'b' } },
                { clientId: 'second', tags: big },
                { clientId: 'third', tags: { c: 'd' } },
            ]);
            expect(roundTrip(msg)).toEqual(msg);
        });

        it('float64 edge values survive bit for bit', () => {
            const values = [
                0,
                -0,
                NaN,
                Infinity,
                -Infinity,
                1.7976931348623157e308,
                5e-324,
                -5e-324,
                8.64e15,
                1713300000123.456,
                Number.MAX_SAFE_INTEGER,
            ];
            for (const value of values) {
                const decoded = roundTrip({
                    type: 'heartbeat',
                    timestamp: value,
                    metrics: {
                        memoryRss: value,
                        memoryHeapUsed: -value,
                        memoryHeapTotal: value,
                        cpuUser: value,
                        cpuSystem: value,
                    },
                    clients: [],
                }) as HeartbeatMessage;
                expect(Object.is(decoded.timestamp, value)).toBe(true);
                expect(Object.is(decoded.metrics?.memoryRss, value)).toBe(true);
                expect(Object.is(decoded.metrics?.memoryHeapUsed, -value)).toBe(true);
                expect(Object.is(decoded.metrics?.cpuSystem, value)).toBe(true);
            }
        });

        it('keeps a __proto__ tag as an own property without touching the prototype', () => {
            const tags = JSON.parse('{"__proto__":"polluted","a":"b"}') as Record<string, string>;
            const decoded = roundTrip({ type: 'client-connected', clientId: 'c', roomId: 'r', tags }) as Extract<
                NotifyMessage,
                { type: 'client-connected' }
            >;
            expect(Object.getOwnPropertyDescriptor(decoded.tags, '__proto__')?.value).toBe('polluted');
            expect(Object.getPrototypeOf(decoded.tags)).toBe(Object.prototype);
            expect(({} as Record<string, string>).polluted).toBeUndefined();
            expect(decoded.tags.a).toBe('b');
        });

        it('encodes after an earlier encode threw', () => {
            expect(() => notifyCodec.pack({ type: 'ready', port: 70000 })).toThrow(RangeError);
            const bad = {
                type: 'heartbeat',
                timestamp: 1,
                metrics: undefined,
                clients: [{ clientId: 'a', tags: { k: undefined } }],
            };
            expect(() => notifyCodec.pack(bad as unknown as NotifyMessage)).toThrow();
            expect(roundTrip({ type: 'stopped' })).toEqual({ type: 'stopped' });
        });

        it('rejects ports that are not uint16', () => {
            for (const port of [-1, 65536, 1.5, NaN, Infinity]) {
                expect(() => notifyCodec.pack({ type: 'ready', port })).toThrow(RangeError);
            }
        });

        it('a message above the retained scratch limit encodes and later messages still work', () => {
            const msg: NotifyMessage = { type: 'error', message: 'e'.repeat(2_000_000) };
            expect(roundTrip(msg)).toEqual(msg);
            expect(roundTrip({ type: 'stopped' })).toEqual({ type: 'stopped' });
        });
    });

    describe('layout', () => {
        it('ready is format, tag 0, u16 little endian port', () => {
            expect(Array.from(notifyCodec.pack({ type: 'ready', port: 0x1234 }))).toEqual([0x81, 0x00, 0x34, 0x12]);
        });

        it('stopped is format then tag 5', () => {
            expect(Array.from(notifyCodec.pack({ type: 'stopped' }))).toEqual([0x81, 0x05]);
        });

        it('client-disconnected is format, tag 3, length-prefixed string', () => {
            expect(Array.from(notifyCodec.pack({ type: 'client-disconnected', clientId: 'ab' }))).toEqual([
                0x81, 0x03, 2, 0x61, 0x62,
            ]);
        });

        it('client-connected is format, tag 2, two strings and a record', () => {
            const bytes = notifyCodec.pack({ type: 'client-connected', clientId: 'a', roomId: 'b', tags: { k: 'v' } });
            expect(Array.from(bytes)).toEqual([0x81, 0x02, 1, 0x61, 1, 0x62, 1, 1, 0x6b, 1, 0x76]);
        });

        it('heartbeat without metrics', () => {
            const bytes = notifyCodec.pack({
                type: 'heartbeat',
                timestamp: 1,
                metrics: undefined,
                clients: [{ clientId: 'a', tags: {} }],
            });
            expect(Array.from(bytes.subarray(0, 2))).toEqual([0x81, 0x01]);
            expect(new DataView(bytes.buffer).getFloat64(2, true)).toBe(1);
            // hasMetrics 0, one client, clientId "a", zero tags
            expect(Array.from(bytes.subarray(10))).toEqual([0, 1, 1, 0x61, 0]);
        });

        it('heartbeat with metrics carries a flag and five float64s', () => {
            const bytes = notifyCodec.pack(heartbeat([]));
            expect(bytes.length).toBe(2 + 8 + 1 + 40 + 1);
            expect(bytes[10]).toBe(1);
            const view = new DataView(bytes.buffer);
            expect([11, 19, 27, 35, 43].map((at) => view.getFloat64(at, true))).toEqual([
                metrics.memoryRss,
                metrics.memoryHeapUsed,
                metrics.memoryHeapTotal,
                metrics.cpuUser,
                metrics.cpuSystem,
            ]);
            expect(bytes[51]).toBe(0);
        });

        it('allocates exactly the encoded size', () => {
            const bytes = notifyCodec.pack(heartbeat(manyClients(50, 4)));
            expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
        });

        it('encodeNotifyFrame equals the length-prefixed payload', () => {
            const messages: NotifyMessage[] = [
                { type: 'ready', port: 4000 },
                { type: 'stopped' },
                heartbeat(manyClients(50, 4)),
                heartbeat(manyClients(3000, 4)),
                { type: 'error', message: 'e'.repeat(1_500_000) },
            ];
            for (const msg of messages) {
                const frame = encodeNotifyFrame(msg);
                expect(Array.from(frame.subarray(0, 4))).toEqual(
                    Array.from(encodeRawFrame(notifyCodec.pack(msg)).subarray(0, 4)),
                );
                expect(frame.length).toBe(encodeRawFrame(notifyCodec.pack(msg)).length);
                expect(frame.buffer.byteLength).toBe(frame.byteLength);
                const received: NotifyMessage[] = [];
                createFrameReader((m) => received.push(m))(frame);
                expect(received).toEqual([msg]);
            }
        });
    });

    describe('untrusted input', () => {
        const valid: NotifyMessage[] = [
            { type: 'ready', port: 4000 },
            heartbeat(
                [
                    { clientId: 'cé', tags: { team: '😀', k: 'v' } },
                    { clientId: 'd', tags: {} },
                ],
                true,
            ),
            heartbeat([{ clientId: 'only', tags: { a: 'b' } }], false),
            { type: 'client-connected', clientId: 'c', roomId: 'ré', tags: { a: 'b' } },
            { type: 'client-disconnected', clientId: 'c' },
            { type: 'error', message: 'm日' },
            { type: 'stopped' },
        ];

        for (const msg of valid) {
            it(`every truncation of ${msg.type}${msg.type === 'heartbeat' ? (msg.metrics ? ' with metrics' : ' without metrics') : ''} throws`, () => {
                const bytes = notifyCodec.pack(msg);
                for (let length = 0; length < bytes.length; length++) {
                    expect(() => notifyCodec.unpack(bytes.subarray(0, length))).toThrow(Error);
                }
            });

            it(`trailing bytes after ${msg.type} throw`, () => {
                const bytes = notifyCodec.pack(msg);
                const padded = new Uint8Array(bytes.length + 1);
                padded.set(bytes);
                expect(() => notifyCodec.unpack(padded)).toThrow(/trailing bytes/);
            });
        }

        it('a different format byte reports a version mismatch, including the old packcat layout', () => {
            for (const first of [0x00, 0x01, 0x05, 0x80, 0x82, 0xff]) {
                expect(() => notifyCodec.unpack(new Uint8Array([first, 0x00, 0x34, 0x12]))).toThrow(
                    /notify format mismatch.*different gatho version/,
                );
            }
        });

        it('rejects unknown tags', () => {
            for (const tag of [6, 7, 0x7f, 0x80, 0xff]) {
                expect(() => notifyCodec.unpack(new Uint8Array([0x81, tag]))).toThrow(/unknown notify message tag/);
            }
        });

        it('rejects an empty payload', () => {
            expect(() => notifyCodec.unpack(new Uint8Array(0))).toThrow(/unexpected end of input/);
        });

        it('rejects a bad metrics flag', () => {
            const bytes = notifyCodec.pack(heartbeat([], false));
            bytes[10] = 2;
            expect(() => notifyCodec.unpack(bytes)).toThrow(/invalid heartbeat metrics flag/);
        });

        it('rejects a client count the remaining input cannot hold', () => {
            const bytes = notifyCodec.pack(heartbeat([], false));
            // zero clients is the last byte, replace it with a count of 4 billion
            const forged = new Uint8Array([...bytes.subarray(0, bytes.length - 1), 0xff, 0xff, 0xff, 0xff, 0x0f]);
            expect(() => notifyCodec.unpack(forged)).toThrow(/count .* exceeds remaining input/);
            const small = new Uint8Array([...bytes.subarray(0, bytes.length - 1), 3, 0, 0, 0, 0, 0]);
            expect(() => notifyCodec.unpack(small)).toThrow(/count 3 exceeds remaining input/);
        });

        it('rejects a tag count the remaining input cannot hold', () => {
            const forged = new Uint8Array([0x81, 0x02, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
            expect(() => notifyCodec.unpack(forged)).toThrow(/count .* exceeds remaining input/);
        });

        it('rejects string lengths past the end of the payload', () => {
            expect(() => notifyCodec.unpack(new Uint8Array([0x81, 0x04, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x61]))).toThrow(
                /exceeds remaining input/,
            );
            expect(() => notifyCodec.unpack(new Uint8Array([0x81, 0x04, 5, 0x61]))).toThrow(/exceeds remaining input/);
        });

        it('rejects invalid utf-8 in a string', () => {
            expect(() => notifyCodec.unpack(new Uint8Array([0x81, 0x04, 1, 0xff]))).toThrow(/invalid utf-8/);
        });

        it('never returns a partial message from a corrupted heartbeat', () => {
            const bytes = notifyCodec.pack(heartbeat(manyClients(5, 3)));
            for (let at = 0; at < bytes.length; at++) {
                const corrupt = bytes.slice();
                corrupt[at] ^= 0xff;
                let result: NotifyMessage | undefined;
                try {
                    result = notifyCodec.unpack(corrupt);
                } catch (err) {
                    expect(err).toBeInstanceOf(Error);
                    continue;
                }
                expect(result.type).toBe('heartbeat');
                const decoded = result as HeartbeatMessage;
                for (const client of decoded.clients) {
                    expect(typeof client.clientId).toBe('string');
                    for (const value of Object.values(client.tags)) expect(typeof value).toBe('string');
                }
            }
        });

        it('reads only within a subarray view', () => {
            const bytes = notifyCodec.pack({ type: 'client-disconnected', clientId: 'view' });
            const padded = new Uint8Array(bytes.length + 6);
            padded.fill(0xaa);
            padded.set(bytes, 3);
            expect(notifyCodec.unpack(padded.subarray(3, 3 + bytes.length))).toEqual({
                type: 'client-disconnected',
                clientId: 'view',
            });
            expect(() => notifyCodec.unpack(padded.subarray(3, 3 + bytes.length - 1))).toThrow(Error);
            const hb = notifyCodec.pack(heartbeat(manyClients(2, 2)));
            const paddedHb = new Uint8Array(hb.length + 5);
            paddedHb.set(hb, 3);
            expect(notifyCodec.unpack(paddedHb.subarray(3, 3 + hb.length))).toEqual(heartbeat(manyClients(2, 2)));
        });

        it('decodes after an earlier decode threw', () => {
            expect(() => notifyCodec.unpack(new Uint8Array([0x81, 0x01, 1]))).toThrow(Error);
            expect(roundTrip({ type: 'stopped' })).toEqual({ type: 'stopped' });
        });

        it('createFrameReader routes a malformed payload to onError and keeps parsing', () => {
            const received: NotifyMessage[] = [];
            const errors: unknown[] = [];
            const push = createFrameReader(
                (m) => received.push(m),
                (e) => errors.push(e),
            );
            const bad = encodeRawFrame(new Uint8Array([0x81, 0x09]));
            const good = encodeNotifyFrame({ type: 'ready', port: 7 });
            const old = encodeRawFrame(new Uint8Array([0x00, 0x07, 0x00]));
            const joined = new Uint8Array(bad.length + old.length + good.length);
            joined.set(bad, 0);
            joined.set(old, bad.length);
            joined.set(good, bad.length + old.length);
            push(joined);
            expect(received).toEqual([{ type: 'ready', port: 7 }]);
            expect(errors).toHaveLength(2);
            expect(String(errors[1])).toMatch(/notify format mismatch/);
        });
    });
});
