// type-level tests: optional data/tags on createRoom, optional ttl on join.

import { type CreateRoomOptions, type JoinOptions } from 'gatho/sdk';
import { describe, expectTypeOf, test } from 'vitest';

describe('sdk optional fields', () => {
    test('CreateRoomOptions.data and .tags are optional', () => {
        // minimal call — only the required fields.
        const minimal: CreateRoomOptions = { type: 'x', serverId: 's' };
        expectTypeOf(minimal).toMatchTypeOf<CreateRoomOptions>();

        // data and tags are optional properties.
        expectTypeOf<CreateRoomOptions['data']>().toEqualTypeOf<
            Record<string, string | number | boolean> | undefined
        >();
        expectTypeOf<CreateRoomOptions['tags']>().toEqualTypeOf<Record<string, string> | undefined>();
    });

    test('JoinOptions.ttl is optional', () => {
        const minimal: JoinOptions = { roomId: 'r' };
        expectTypeOf(minimal).toMatchTypeOf<JoinOptions>();
        expectTypeOf<JoinOptions['ttl']>().toEqualTypeOf<number | undefined>();
    });
});
