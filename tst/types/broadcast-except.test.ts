// type-level test for the broadcast except option shape.

import type { BroadcastOptions, Client } from 'gatho/room';
import { describe, expectTypeOf, test } from 'vitest';

describe('broadcast except option', () => {
    test('except accepts a client or an array of clients', () => {
        expectTypeOf<BroadcastOptions['except']>().toEqualTypeOf<
            Client<Record<string, unknown>> | Client<Record<string, unknown>>[] | undefined
        >();
    });
});
