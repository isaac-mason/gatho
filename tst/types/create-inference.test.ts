// type-level tests for CreateOptions generic structure.
// verifies the shape of CreateOptions at the type level.

import type { Client, CreateOptions } from 'gatho/room';
import { describe, expectTypeOf, test } from 'vitest';

describe('CreateOptions type structure', () => {
    test('ClientData flows through Client in callbacks — no room param', () => {
        type Opts = CreateOptions<{ username: string }>;
        type OnJoin = NonNullable<Opts['onJoin']>;

        // callbacks no longer receive room — the client handle is the only param.
        type ClientArg = Parameters<OnJoin>[0];
        expectTypeOf<ClientArg>().toMatchObjectType<Client<{ username: string }>>();
    });

    test('JoinData appears as onAuth first (and only) parameter', () => {
        type Opts = CreateOptions<{ username: string }, { displayName?: string }>;
        type OnAuth = NonNullable<Opts['onAuth']>;

        type JoinDataArg = Parameters<OnAuth>[0];
        expectTypeOf<JoinDataArg>().toEqualTypeOf<{ displayName?: string }>();
    });

    test('onMessage receives (client, string | ArrayBuffer)', () => {
        type Opts = CreateOptions<{ username: string }>;
        type OnMessage = NonNullable<Opts['onMessage']>;

        type MessageArg = Parameters<OnMessage>[1];
        expectTypeOf<MessageArg>().toEqualTypeOf<string | ArrayBuffer>();
    });

    test('defaults: JoinData is Record<string, unknown>', () => {
        type Opts = CreateOptions<{ username: string }>;
        type OnAuth = NonNullable<Opts['onAuth']>;

        type JoinDataArg = Parameters<OnAuth>[0];
        expectTypeOf<JoinDataArg>().toEqualTypeOf<Record<string, unknown>>();
    });
});
