import { describe, expect, it } from 'vitest';
import { packProtocol, PROTOCOL_VERSION, unpackFrame } from '../../src/common/protocol';

describe('protocol', () => {
    it('exposes a numeric PROTOCOL_VERSION', () => {
        expect(typeof PROTOCOL_VERSION).toBe('number');
        expect(PROTOCOL_VERSION).toBe(1);
    });

    it('roundtrips a session message carrying token and clientId', () => {
        const frame = packProtocol({ type: 'session', token: 'tok-abc', clientId: 'client-123' });
        const decoded = unpackFrame(frame);

        expect(decoded.frame).toBe('protocol');
        if (decoded.frame !== 'protocol') throw new Error('expected protocol frame');
        expect(decoded.message).toEqual({ type: 'session', token: 'tok-abc', clientId: 'client-123' });
    });

    it('preserves distinct token and clientId values across the wire', () => {
        // token and clientId are independent strings — the codec must not
        // conflate them even when they look similar.
        const frame = packProtocol({ type: 'session', token: 'x'.repeat(32), clientId: 'x'.repeat(36) });
        const decoded = unpackFrame(frame);
        if (decoded.frame !== 'protocol' || decoded.message.type !== 'session') {
            throw new Error('expected session message');
        }
        expect(decoded.message.token.length).toBe(32);
        expect(decoded.message.clientId.length).toBe(36);
        expect(decoded.message.token).not.toBe(decoded.message.clientId);
    });

    it('roundtrips auth_error unchanged', () => {
        const frame = packProtocol({ type: 'auth_error', error: 'protocol version mismatch (client none, server 1)' });
        const decoded = unpackFrame(frame);
        if (decoded.frame !== 'protocol') throw new Error('expected protocol frame');
        expect(decoded.message).toEqual({
            type: 'auth_error',
            error: 'protocol version mismatch (client none, server 1)',
        });
    });
});
