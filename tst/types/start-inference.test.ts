// type-level tests for StartOptions generic structure.
// verifies the shape of StartOptions at the type level.
import { describe, expectTypeOf, test } from 'vitest';
import { auth, type Client, type Room, type StartOptions } from '../../room';

describe('StartOptions type structure', () => {
    test('ClientData flows through Room and Client in callbacks', () => {
        type Opts = StartOptions<{ username: string }>;
        type OnJoin = NonNullable<Opts['onJoin']>;

        type RoomArg = Parameters<OnJoin>[0];
        type ClientArg = Parameters<OnJoin>[1];
        expectTypeOf<RoomArg>().toMatchTypeOf<Room<{ username: string }>>();
        expectTypeOf<ClientArg>().toMatchTypeOf<Client<{ username: string }>>();
    });

    test('JoinData appears in onAuth parameter', () => {
        type Opts = StartOptions<{ username: string }, { displayName?: string }>;
        type OnAuth = Opts['onAuth'];

        type JoinDataArg = Parameters<OnAuth>[0];
        expectTypeOf<JoinDataArg>().toEqualTypeOf<{ displayName?: string }>();
    });

    test('InMessage appears in onMessage parameter', () => {
        type Opts = StartOptions<{ username: string }, Record<string, unknown>, { text: string }>;
        type OnMessage = NonNullable<Opts['onMessage']>;

        type MessageArg = Parameters<OnMessage>[2];
        expectTypeOf<MessageArg>().toEqualTypeOf<{ text: string }>();
    });

    test('defaults: JoinData is Record<string, unknown>, InMessage is unknown', () => {
        type Opts = StartOptions<{ username: string }>;

        type OnAuth = Opts['onAuth'];
        type JoinDataArg = Parameters<OnAuth>[0];
        expectTypeOf<JoinDataArg>().toEqualTypeOf<Record<string, unknown>>();

        type OnMessage = NonNullable<Opts['onMessage']>;
        type MessageArg = Parameters<OnMessage>[2];
        expectTypeOf<MessageArg>().toEqualTypeOf<unknown>();
    });

    test('onAuth has no room parameter', () => {
        type Opts = StartOptions<{ username: string }>;
        type OnAuth = Opts['onAuth'];

        // onAuth should only take 1 parameter (joinData)
        type Params = Parameters<OnAuth>;
        expectTypeOf<Params['length']>().toEqualTypeOf<1>();
    });
});
