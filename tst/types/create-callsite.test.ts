// type-level tests for create() generic inference against the REAL api shape.
// this is the spike regression: handlers-at-create with a self-referencing
// `const room = create({...})` must infer ClientData fully — no TS7022
// ('room' referenced directly or indirectly in its own initializer), and
// client.data typed everywhere even with room.clients.count() inside onAuth.
//
// we use a local `create` shim typed identically to the real export (via
// `typeof create`) so this stays a pure compile-time check — it never spins up
// a real room. the shim's return type is the real Room<ClientData>, so the
// self-reference exercises the exact inference path the real api uses.

import { auth, create as realCreate, type Room } from 'gatho/room';
import { describe, expectTypeOf, test } from 'vitest';

const create: typeof realCreate = realCreate;

describe('create() generic inference', () => {
    test('self-referencing room in onAuth infers ClientData fully', () => {
        // the locked contract: onAuth closes over `room` (capacity check) while
        // its return type drives ClientData inference, and the whole thing
        // compiles clean with client.data typed in every callback.
        const room: Room<{ name: string }> = create({
            standalone: true,
            onAuth: (join: { name: string }) =>
                room.clients.count() < 8 ? auth.ok({ name: join.name }) : auth.fail('full'),
            onJoin: (client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ name: string }>();
                // per-client verbs live on the handle now.
                expectTypeOf(client.send).toBeFunction();
                expectTypeOf(client.allowReconnection).toBeFunction();
                expectTypeOf(client.disconnect).toBeFunction();
                expectTypeOf(client.bufferedAmount).toBeNumber();
                room.broadcast('x');
            },
            onMessage: (client, message) => {
                expectTypeOf(client.data).toEqualTypeOf<{ name: string }>();
                expectTypeOf(message).toEqualTypeOf<string | ArrayBuffer>();
            },
            onDrop: (client, code) => {
                expectTypeOf(client.data).toEqualTypeOf<{ name: string }>();
                expectTypeOf(code).toBeNumber();
                client.allowReconnection(30_000);
            },
            onReconnect: (client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ name: string }>();
            },
            onLeave: (client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ name: string }>();
            },
        });

        // the returned handle satisfies Room<ClientData>.
        expectTypeOf(room).toMatchObjectType<Room<{ name: string }>>();
        expectTypeOf(room.start).toBeFunction();
        expectTypeOf(room.stop).toBeFunction();
    });

    test('no onAuth — ClientData is unbound (unknown), callbacks still typed', () => {
        const room = create({
            standalone: true,
            onJoin: (client) => {
                // no onAuth means ClientData is never inferred — it stays unknown.
                expectTypeOf(client.data).toEqualTypeOf<unknown>();
                room.broadcast('hi');
            },
            onMessage: (_client, message) => {
                expectTypeOf(message).toEqualTypeOf<string | ArrayBuffer>();
            },
        });
        expectTypeOf(room).toMatchObjectType<Room<unknown>>();
    });

    test('only joinData annotated', () => {
        const room = create({
            standalone: true,
            onAuth: (joinData: { token: string }) => auth.ok({ verified: true, token: joinData.token }),
            onJoin: (client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ verified: boolean; token: string }>();
            },
        });
        expectTypeOf(room).toMatchObjectType<Room<{ verified: boolean; token: string }>>();
    });

    test('client connect handler bag typing', () => {
        type ConnectHandlers = import('gatho/client').ConnectHandlers;
        expectTypeOf<NonNullable<ConnectHandlers['onOpen']>>().toEqualTypeOf<() => void>();
        expectTypeOf<NonNullable<ConnectHandlers['onMessage']>>().parameter(0).toEqualTypeOf<string | ArrayBuffer>();
        expectTypeOf<NonNullable<ConnectHandlers['onClose']>>()
            .parameter(0)
            .toMatchObjectType<import('gatho/client').CloseInfo>();
    });
});
