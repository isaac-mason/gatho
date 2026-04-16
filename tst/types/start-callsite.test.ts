// type-level tests for start() generic inference.
// verifies that ClientData and JoinData are correctly inferred from callback annotations.
import { describe, expectTypeOf, test } from 'vitest';
import { auth, type StartOptions } from '../../room';

// real function with the same generic signature as start().
// avoids spinning up an actual server — we only care about types.
function mockStart<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>>(
    _options: StartOptions<ClientData, JoinData>,
): void {}

describe('start() generic inference', () => {
    test('ClientData from auth.ok, JoinData from annotation', () => {
        mockStart({
            onAuth: (joinData: { displayName?: string }) => {
                return auth.ok({ username: joinData.displayName || 'anon' });
            },

            onJoin: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ username: string }>();
            },

            onMessage: (_room, client, message) => {
                expectTypeOf(client.data).toEqualTypeOf<{ username: string }>();
                expectTypeOf(message).toEqualTypeOf<string | ArrayBuffer>();
            },

            onLeave: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ username: string }>();
            },
        });
    });

    test('no annotations — defaults: joinData is Record<string, unknown>, message is string | ArrayBuffer', () => {
        mockStart({
            onAuth: () => auth.ok({ level: 5 }),
            onJoin: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ level: number }>();
            },
            onMessage: (_room, _client, message) => {
                expectTypeOf(message).toEqualTypeOf<string | ArrayBuffer>();
            },
        });
    });

    test('only joinData annotated', () => {
        mockStart({
            onAuth: (joinData: { token: string }) => {
                return auth.ok({ verified: true, token: joinData.token });
            },
            onJoin: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ verified: boolean; token: string }>();
            },
        });
    });

    test('explicit generic still works as escape hatch', () => {
        mockStart<{ username: string }>({
            onAuth: () => auth.ok({ username: 'test' }),
            onJoin: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ username: string }>();
            },
        });
    });

    test('onDrop and onReconnect get correct ClientData', () => {
        mockStart({
            onAuth: () => auth.ok({ sessionId: 'abc' }),
            onDrop: (_room, client, code) => {
                expectTypeOf(client.data).toEqualTypeOf<{ sessionId: string }>();
                expectTypeOf(code).toBeNumber();
            },
            onReconnect: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ sessionId: string }>();
            },
        });
    });
});
