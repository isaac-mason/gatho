/** sign a payload with hs256, returns a compact jwt string */
export declare function jwtSign(payload: Record<string, unknown>, secret: string): Promise<string>;
/** verify a compact jwt string, returns the payload or null if invalid/expired */
export declare function jwtVerify(token: string, secret: string): Promise<Record<string, unknown> | null>;
/** tolerated clock skew between the host that mints a token and the one that verifies it */
export declare const JWT_CLOCK_LEEWAY_MS = 30000;
