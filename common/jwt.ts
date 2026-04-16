// minimal hmac-sha256 jwt — no external deps.
// single source of truth for sign + verify across drivers and room workers.

import { createHmac } from 'node:crypto';

// static header — always the same, computed once
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/** sign a payload with hs256, returns a compact jwt string */
export function jwtSign(payload: Record<string, unknown>, secret: string): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(`${JWT_HEADER}.${body}`).digest('base64url');
    return `${JWT_HEADER}.${body}.${signature}`;
}

/** verify a compact jwt string, returns the payload or null if invalid/expired */
export function jwtVerify(token: string, secret: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    if (signature !== expected) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;

    if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;

    return payload;
}
