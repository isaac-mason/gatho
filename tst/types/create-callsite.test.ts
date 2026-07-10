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

import { type AuthResult, create as realCreate, type Room } from 'gatho/room';
import { describe, expectTypeOf, test } from 'vitest';

const create: typeof realCreate = realCreate;

describe('create() generic inference', () => {
    test('self-referencing room in onAuth infers ClientData fully', () => {
        // the locked contract: onAuth closes over `room` (capacity check) while
        // its return type drives ClientData inference, and the whole thing
        // compiles clean with client.data typed in every callback.
        //
        // the `room` reference lives in a STATEMENT (if-guard in a block body),
        // NOT inside the returned expression — an arrow whose expression body is
        // `room.x ? {ok:false,...} : {ok:true,...}` makes the inferred return type
        // circular and fails with TS7022. keep the room read in a statement.
        const room: Room<{ name: string }> = create({
            standalone: true,
            onAuth: (join: { name: string }) => {
                if (room.clients.count() >= 8) return { ok: false, error: 'full' };
                return { ok: true, data: { name: join.name } };
            },
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
            onAuth: (joinData: { token: string }) => ({ ok: true, data: { verified: true, token: joinData.token } }),
            onJoin: (client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ verified: boolean; token: string }>();
            },
        });
        expectTypeOf(room).toMatchObjectType<Room<{ verified: boolean; token: string }>>();
    });

    test('plain-literal early returns in a block body infer ClientData', () => {
        // a block body with an early-return reject arm and an accept arm — both
        // plain literals — infers ClientData from the accept arm.
        const room = create({
            standalone: true,
            onAuth: (join: { name: string }) => {
                if (!join.name) return { ok: false, error: 'no name' };
                return { ok: true, data: { name: join.name } };
            },
            onJoin: (client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ name: string }>();
            },
        });
        expectTypeOf(room).toMatchObjectType<Room<{ name: string }>>();
    });

    test('async onAuth returning plain literals infers ClientData', () => {
        const room = create({
            standalone: true,
            onAuth: async (join: { token: string }) => {
                if (!join.token) return { ok: false, error: 'unauthorized' };
                return { ok: true, data: { token: join.token } };
            },
            onJoin: (client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ token: string }>();
            },
        });
        expectTypeOf(room).toMatchObjectType<Room<{ token: string }>>();
    });

    test('accept-all with empty data literal', () => {
        // the plain-literal replacement for the old auth.ok() with no argument.
        // `data: {}` infers the empty object type for ClientData.
        const room = create({
            standalone: true,
            onAuth: () => ({ ok: true, data: {} }),
            onJoin: (client) => {
                // biome-ignore lint/complexity/noBannedTypes: {} is the literal inferred type
                expectTypeOf(client.data).toEqualTypeOf<{}>();
            },
        });
        // biome-ignore lint/complexity/noBannedTypes: {} is the literal inferred type
        expectTypeOf(room).toMatchObjectType<Room<{}>>();
    });

    test('widening footgun: hoisting to an untyped local breaks the union', () => {
        // FOOTGUN (verified): hoisting the result through an untyped local widens
        // `ok` from `true` to `boolean`, so the value no longer matches the
        // `{ ok: true; data }` arm and fails assignability to AuthResult. return
        // the literal directly, or annotate the local, to keep `ok` narrow.
        create({
            standalone: true,
            // @ts-expect-error — `res.ok` widens to boolean; not assignable to AuthResult
            onAuth: (join: { name: string }) => {
                const res = { ok: true, data: { name: join.name } };
                return res;
            },
        });

        // the fix: annotating the local pins `ok: true` and it assigns cleanly.
        const room = create({
            standalone: true,
            onAuth: (join: { name: string }) => {
                const res: AuthResult<{ name: string }> = { ok: true, data: { name: join.name } };
                return res;
            },
            onJoin: (client) => {
                expectTypeOf(client.data).toEqualTypeOf<{ name: string }>();
            },
        });
        expectTypeOf(room).toMatchObjectType<Room<{ name: string }>>();
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
