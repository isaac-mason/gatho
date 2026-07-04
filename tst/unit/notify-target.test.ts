import { describe, expect, it } from 'vitest';
import { parseNotifyTarget } from '../../src/room/ipc';

describe('parseNotifyTarget', () => {
    it('parses a uds: uri into a uds target', () => {
        expect(parseNotifyTarget('uds:/x/sock')).toEqual({ kind: 'uds', path: '/x/sock' });
    });

    it('parses a tcp:// uri into host/port/token', () => {
        expect(parseNotifyTarget('tcp://127.0.0.1:9?token=abc')).toEqual({
            kind: 'tcp',
            host: '127.0.0.1',
            port: 9,
            token: 'abc',
        });
    });

    it('parses a tcp:// uri without a token as token ""', () => {
        expect(parseNotifyTarget('tcp://127.0.0.1:9')).toEqual({
            kind: 'tcp',
            host: '127.0.0.1',
            port: 9,
            token: '',
        });
    });

    it('treats a bare filesystem path as a uds target', () => {
        expect(parseNotifyTarget('/tmp/x/sock')).toEqual({ kind: 'uds', path: '/tmp/x/sock' });
    });

    it('throws on a tcp:// uri with port 0', () => {
        expect(() => parseNotifyTarget('tcp://host:0')).toThrow(/invalid tcp port/);
    });

    it('throws on a tcp:// uri with no port', () => {
        expect(() => parseNotifyTarget('tcp://host')).toThrow(/invalid tcp port/);
    });

    it('throws on an unsupported uri scheme', () => {
        expect(() => parseNotifyTarget('wss://x')).toThrow(/unsupported uri scheme/);
    });
});
