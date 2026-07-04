// minimal hmac-sha256 jwt — no external deps.
// single source of truth for sign + verify across drivers and rooms.
//
// built on WebCrypto (async) rather than node:crypto so the verify side runs
// in any runtime a room might be hosted in (node, workerd, deno, bun).

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
    const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// CryptoKey cache — importKey is an async round-trip and sign/verify sit on hot
// paths (every reservation, every ws upgrade). keyed by usage+secret; capped so
// a long-lived process signing for many rooms doesn't grow unboundedly (Map
// iteration order = insertion order, so evicting the first entry is FIFO).
const KEY_CACHE_MAX = 256;
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
    const cacheKey = `${usage}:${secret}`;
    const cached = keyCache.get(cacheKey);
    if (cached) return cached;

    const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
    if (keyCache.size >= KEY_CACHE_MAX) {
        const oldest = keyCache.keys().next().value;
        if (oldest !== undefined) keyCache.delete(oldest);
    }
    keyCache.set(cacheKey, key);
    key.catch(() => keyCache.delete(cacheKey));
    return key;
}

// static header — always the same, computed once
const JWT_HEADER = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

/** sign a payload with hs256, returns a compact jwt string */
export async function jwtSign(payload: Record<string, unknown>, secret: string): Promise<string> {
    const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
    const key = await hmacKey(secret, 'sign');
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${JWT_HEADER}.${body}`)));
    return `${JWT_HEADER}.${body}.${toBase64Url(signature)}`;
}

/** verify a compact jwt string, returns the payload or null if invalid/expired */
export async function jwtVerify(token: string, secret: string): Promise<Record<string, unknown> | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;

    let valid: boolean;
    try {
        const key = await hmacKey(secret, 'verify');
        // subtle.verify rather than a string compare — constant-time on the mac check
        valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(signature), encoder.encode(`${header}.${body}`));
    } catch {
        return null; // malformed base64url etc.
    }
    if (!valid) return null;

    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Record<string, unknown>;
    } catch {
        return null;
    }

    if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;

    return payload;
}
