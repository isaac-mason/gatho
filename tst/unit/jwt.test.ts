import { describe, expect, it } from 'vitest';
import { jwtSign, jwtVerify } from '../../src/common/jwt';

describe('jwt sign/verify', () => {
    it('round-trips a payload', async () => {
        const payload = { sub: 'user-1', roomId: 'room-1', n: 42, flag: true };
        const token = await jwtSign(payload, 'secret');
        const verified = await jwtVerify(token, 'secret');
        expect(verified).toEqual(payload);
    });

    it('returns null when verified with the wrong secret', async () => {
        const token = await jwtSign({ a: 1 }, 'right-secret');
        expect(await jwtVerify(token, 'wrong-secret')).toBeNull();
    });

    it('returns null when the body is tampered', async () => {
        const token = await jwtSign({ a: 1 }, 'secret');
        const [header, body, sig] = token.split('.');
        // flip a character in the body
        const flipped = (body[0] === 'a' ? 'b' : 'a') + body.slice(1);
        expect(await jwtVerify(`${header}.${flipped}.${sig}`, 'secret')).toBeNull();
    });

    it('returns null when the signature is tampered', async () => {
        const token = await jwtSign({ a: 1 }, 'secret');
        const [header, body, sig] = token.split('.');
        const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
        expect(await jwtVerify(`${header}.${body}.${flipped}`, 'secret')).toBeNull();
    });

    it('returns null for a garbage token / wrong part count', async () => {
        expect(await jwtVerify('garbage', 'secret')).toBeNull();
        expect(await jwtVerify('a.b', 'secret')).toBeNull();
        expect(await jwtVerify('a.b.c.d', 'secret')).toBeNull();
        expect(await jwtVerify('', 'secret')).toBeNull();
    });

    it('honors the exp claim', async () => {
        const past = await jwtSign({ exp: Date.now() - 1000 }, 'secret');
        expect(await jwtVerify(past, 'secret')).toBeNull();

        const future = await jwtSign({ exp: Date.now() + 60_000, sub: 'x' }, 'secret');
        expect(await jwtVerify(future, 'secret')).toEqual({ exp: expect.any(Number), sub: 'x' });

        const noExp = await jwtSign({ sub: 'y' }, 'secret');
        expect(await jwtVerify(noExp, 'secret')).toEqual({ sub: 'y' });
    });

    it('returns null (no throw) for non-base64url junk in the parts', async () => {
        // '!' and '@' are not valid base64url characters — atob / decode must not
        // throw out of jwtVerify, just yield null.
        await expect(jwtVerify('!!!.@@@.###', 'secret')).resolves.toBeNull();

        // valid-looking header/body but junk signature
        const token = await jwtSign({ a: 1 }, 'secret');
        const [header, body] = token.split('.');
        await expect(jwtVerify(`${header}.${body}.@@@!`, 'secret')).resolves.toBeNull();
    });

    it('is deterministic — same payload + secret produces the same token', async () => {
        const payload = { sub: 'user-1', n: 7 };
        const a = await jwtSign(payload, 'secret');
        const b = await jwtSign(payload, 'secret');
        expect(a).toBe(b);
    });

    it('survives cache eviction — signing 300 distinct secrets then re-signing the first still works', async () => {
        const firstSecret = 'secret-0';
        const firstToken = await jwtSign({ i: 0 }, firstSecret);

        // sign with 300 distinct secrets to overflow the 256-entry FIFO key cache,
        // evicting the first secret's cached CryptoKey.
        for (let i = 0; i < 300; i++) {
            await jwtSign({ i }, `secret-${i}`);
        }

        // re-signing with the (now evicted) first secret must transparently
        // re-import the key and produce the identical token.
        const again = await jwtSign({ i: 0 }, firstSecret);
        expect(again).toBe(firstToken);

        // and it must still verify
        expect(await jwtVerify(again, firstSecret)).toEqual({ i: 0 });
    });
});
