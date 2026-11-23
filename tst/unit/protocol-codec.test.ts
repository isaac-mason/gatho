import { describe, expect, it } from 'vitest';
import { type ProtocolMessage, packProtocol, packUserBinary, packUserText, unpackFrame } from '../../src/common/protocol';

const utf8 = new TextEncoder();

function decodeProtocol(bytes: Uint8Array): ProtocolMessage {
    const frame = unpackFrame(bytes);
    if (frame.frame !== 'protocol') throw new Error('expected protocol frame');
    return frame.message;
}

const strings: Record<string, string> = {
    empty: '',
    ascii: 'tok-abc',
    'two byte': 'héllo wörld',
    'three byte': '日本語',
    astral: '😀 party 🎉 \u{1d11e}',
    'leading bom': '﻿abc',
    'real replacement char': 'a�b',
    'boundary 42 units': 'x'.repeat(42),
    'boundary 43 units': 'x'.repeat(43),
    'boundary 127 bytes': 'y'.repeat(127),
    'boundary 128 bytes': 'y'.repeat(128),
    'long ascii': 'z'.repeat(70_000),
    'long mixed': 'é😀a'.repeat(5000),
    'above retained scratch limit': 'q'.repeat(1_500_000),
};

describe('protocol codec', () => {
    describe('round trips', () => {
        for (const [name, value] of Object.entries(strings)) {
            it(`session with ${name} strings`, () => {
                const message = { type: 'session', token: value, clientId: `${value}!` } as const;
                expect(decodeProtocol(packProtocol(message))).toEqual(message);
            });

            it(`auth_error with ${name} string`, () => {
                const message = { type: 'auth_error', error: value } as const;
                expect(decodeProtocol(packProtocol(message))).toEqual(message);
            });
        }

        it('leave', () => {
            expect(decodeProtocol(packProtocol({ type: 'leave' }))).toEqual({ type: 'leave' });
        });

        it('a lone surrogate becomes U+FFFD like TextEncoder', () => {
            for (const lone of ['\ud83d', '\ude00', 'a\ud83d', '\ud83dz', '\ude00\ud83d']) {
                const decoded = decodeProtocol(packProtocol({ type: 'auth_error', error: lone }));
                expect(decoded).toEqual({ type: 'auth_error', error: new TextDecoder().decode(utf8.encode(lone)) });
            }
        });

        it('every utf-8 width at every short string length matches TextEncoder', () => {
            const units = ['a', 'é', '日', '😀'];
            for (let length = 0; length < 60; length++) {
                for (const unit of units) {
                    const text = unit.repeat(length);
                    const frame = packProtocol({ type: 'auth_error', error: text });
                    const expectedBody = utf8.encode(text);
                    // frame type, tag, varint length, body
                    const lengthBytes = frame.length - 2 - expectedBody.length;
                    expect(Array.from(frame.subarray(2 + lengthBytes))).toEqual(Array.from(expectedBody));
                    expect(decodeProtocol(frame)).toEqual({ type: 'auth_error', error: text });
                }
            }
        });
    });

    describe('layout', () => {
        it('session is frame type, tag 0, then two length-prefixed strings', () => {
            const frame = packProtocol({ type: 'session', token: 'abc', clientId: 'x' });
            expect(Array.from(frame)).toEqual([0x00, 0x00, 3, 0x61, 0x62, 0x63, 1, 0x78]);
        });

        it('auth_error is frame type, tag 1, then a length-prefixed string', () => {
            const frame = packProtocol({ type: 'auth_error', error: 'no' });
            expect(Array.from(frame)).toEqual([0x00, 0x01, 2, 0x6e, 0x6f]);
        });

        it('leave is frame type then tag 2', () => {
            expect(Array.from(packProtocol({ type: 'leave' }))).toEqual([0x00, 0x02]);
        });

        it('a string over 127 bytes carries a two byte length', () => {
            const frame = packProtocol({ type: 'auth_error', error: 'y'.repeat(128) });
            expect(Array.from(frame.subarray(0, 4))).toEqual([0x00, 0x01, 0x80, 0x01]);
        });

        it('allocates exactly the encoded size', () => {
            const frame = packProtocol({ type: 'session', token: 'abc', clientId: 'x' });
            expect(frame.buffer.byteLength).toBe(frame.byteLength);
        });

        it('consecutive encodes do not share memory', () => {
            const a = packProtocol({ type: 'auth_error', error: 'first' });
            const b = packProtocol({ type: 'auth_error', error: 'other' });
            expect(decodeProtocol(a)).toEqual({ type: 'auth_error', error: 'first' });
            expect(decodeProtocol(b)).toEqual({ type: 'auth_error', error: 'other' });
        });

        it('user frames keep the raw layout', () => {
            expect(Array.from(packUserText('hi'))).toEqual([0x01, 0x68, 0x69]);
            expect(Array.from(packUserBinary(new Uint8Array([9, 8])))).toEqual([0x02, 9, 8]);
            expect(unpackFrame(packUserText('hé'))).toEqual({ frame: 'user_text', text: 'hé' });
        });
    });

    describe('untrusted input', () => {
        const valid: ProtocolMessage[] = [
            { type: 'session', token: 'tok-é', clientId: 'client-😀' },
            { type: 'auth_error', error: 'bad' },
            { type: 'leave' },
        ];

        for (const message of valid) {
            it(`every truncation of ${message.type} throws`, () => {
                const frame = packProtocol(message);
                for (let length = 0; length < frame.length; length++) {
                    expect(() => unpackFrame(frame.subarray(0, length))).toThrow(Error);
                }
            });

            it(`trailing bytes after ${message.type} throw`, () => {
                const frame = packProtocol(message);
                const padded = new Uint8Array(frame.length + 1);
                padded.set(frame);
                expect(() => unpackFrame(padded)).toThrow(/trailing bytes/);
            });
        }

        it('rejects unknown tags', () => {
            for (const tag of [3, 4, 0x7f, 0x80, 0xff]) {
                expect(() => unpackFrame(new Uint8Array([0x00, tag]))).toThrow(/unknown protocol message tag/);
            }
        });

        it('rejects unknown frame types', () => {
            expect(() => unpackFrame(new Uint8Array([0x03, 0x00]))).toThrow(/unknown frame type/);
        });

        it('rejects an empty frame', () => {
            expect(() => unpackFrame(new Uint8Array(0))).toThrow(/empty frame/);
        });

        it('rejects a string length larger than the remaining input', () => {
            expect(() => unpackFrame(new Uint8Array([0x00, 0x01, 5, 0x61]))).toThrow(/exceeds remaining input/);
        });

        it('rejects a four gigabyte string length without allocating', () => {
            const frame = new Uint8Array([0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x61]);
            expect(() => unpackFrame(frame)).toThrow(/exceeds remaining input/);
        });

        it('rejects a varint beyond uint32', () => {
            expect(() => unpackFrame(new Uint8Array([0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0x10]))).toThrow(
                /varint exceeds uint32/,
            );
            expect(() => unpackFrame(new Uint8Array([0x00, 0x01, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))).toThrow(
                /varint exceeds uint32/,
            );
        });

        it('rejects an overlong varint', () => {
            expect(() => unpackFrame(new Uint8Array([0x00, 0x01, 0x81, 0x00, 0x61]))).toThrow(/overlong varint/);
        });

        it('rejects invalid utf-8', () => {
            for (const body of [[0xff], [0xc0, 0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0x80]]) {
                const frame = new Uint8Array([0x00, 0x01, body.length, ...body]);
                expect(() => unpackFrame(frame)).toThrow(/invalid utf-8/);
            }
        });

        it('reads only within a subarray view', () => {
            const frame = packProtocol({ type: 'auth_error', error: 'view' });
            const padded = new Uint8Array(frame.length + 6);
            padded.fill(0xaa);
            padded.set(frame, 3);
            expect(decodeProtocol(padded.subarray(3, 3 + frame.length))).toEqual({ type: 'auth_error', error: 'view' });
            // a truncated view must not read the neighbouring bytes
            expect(() => unpackFrame(padded.subarray(3, 3 + frame.length - 1))).toThrow(Error);
        });

        it('decodes after an earlier decode threw', () => {
            expect(() => unpackFrame(new Uint8Array([0x00, 0x01, 9]))).toThrow(Error);
            expect(decodeProtocol(packProtocol({ type: 'leave' }))).toEqual({ type: 'leave' });
        });

        it('encodes after an earlier encode threw', () => {
            const bad = { type: 'auth_error', error: undefined } as unknown as ProtocolMessage;
            expect(() => packProtocol(bad)).toThrow();
            expect(Array.from(packProtocol({ type: 'leave' }))).toEqual([0x00, 0x02]);
        });

        it('accepts an ArrayBuffer', () => {
            const frame = packProtocol({ type: 'auth_error', error: 'buf' });
            expect(unpackFrame(frame.buffer)).toEqual({ frame: 'protocol', message: { type: 'auth_error', error: 'buf' } });
        });
    });
});
