// type-level tests for start() generic inference.
// verifies that ClientData, JoinData, and InMessage are all correctly
// inferred from callback annotations without explicit generics.
import { describe, expectTypeOf, test } from 'vitest';
import { auth, type StartOptions } from '../../room';

// real function with the same generic signature as start().
// avoids spinning up an actual server — we only care about types.
function mockStart<ClientData, JoinData extends Record<string, unknown> = Record<string, unknown>, InMessage = unknown>(
    _options: StartOptions<ClientData, JoinData, InMessage>,
): void {}

describe('start() generic inference', () => {
    test('all three inferred: ClientData from auth.ok, JoinData and InMessage from annotations', () => {
        mockStart({
            onAuth: (joinData: { displayName?: string }) => {
                return auth.ok({ username: joinData.displayName || 'anon' });
            },

            onJoin: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ username: string }>();
            },

            onMessage: (_room, client, message: { text: string }) => {
                expectTypeOf(client.data).toEqualTypeOf<{ username: string }>();
                expectTypeOf(message.text).toBeString();
            },

            onLeave: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ username: string }>();
            },
        });
    });

    test('no annotations — defaults: joinData is Record<string, unknown>, message is unknown', () => {
        mockStart({
            onAuth: () => auth.ok({ level: 5 }),
            onJoin: (_room, client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ level: number }>();
            },
            onMessage: (_room, _client, message) => {
                expectTypeOf(message).toBeUnknown();
            },
        });
    });

    test('only joinData annotated, no InMessage', () => {
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
