// type-level tests for StartOptions generic structure.
// verifies the shape of StartOptions at the type level.
import { describe, expectTypeOf, test } from 'vitest';
import type { Client, Room, StartOptions } from '../../room';

describe('StartOptions type structure', () => {
    test('ClientData flows through Room and Client in callbacks', () => {
        type Opts = StartOptions<{ username: string }>;
        type OnJoin = NonNullable<Opts['onJoin']>;

        type RoomArg = Parameters<OnJoin>[0];
        type ClientArg = Parameters<OnJoin>[1];
        expectTypeOf<RoomArg>().toMatchObjectType<Room<{ username: string }>>();
        expectTypeOf<ClientArg>().toMatchObjectType<Client<{ username: string }>>();
    });

    test('JoinData appears in onAuth parameter', () => {
        type Opts = StartOptions<{ username: string }, { displayName?: string }>;
        type OnAuth = NonNullable<Opts['onAuth']>;

        type JoinDataArg = Parameters<OnAuth>[1];
        expectTypeOf<JoinDataArg>().toEqualTypeOf<{ displayName?: string }>();
    });

    test('onMessage receives string | ArrayBuffer', () => {
        type Opts = StartOptions<{ username: string }>;
        type OnMessage = NonNullable<Opts['onMessage']>;

        type MessageArg = Parameters<OnMessage>[2];
        expectTypeOf<MessageArg>().toEqualTypeOf<string | ArrayBuffer>();
    });

    test('defaults: JoinData is Record<string, unknown>', () => {
        type Opts = StartOptions<{ username: string }>;
        type OnAuth = NonNullable<Opts['onAuth']>;

        type JoinDataArg = Parameters<OnAuth>[1];
        expectTypeOf<JoinDataArg>().toEqualTypeOf<Record<string, unknown>>();
    });
});
