// taste #2: ioredis packaging — `gatho/driver` must not pull ioredis.
//
// ioredis is an optional peer dep. `src/driver/index.ts` no longer re-exports the
// redis driver, so a memory-only / bundled (workerd host) install can import
// `gatho/driver` without ioredis present. we prove this at the build level by
// inspecting the built bundles: dist/driver.js must contain zero ioredis
// references, while the redis driver lives on its own dist/driver-redis.js bundle
// which does import ioredis (as an external).
//
// this asserts against the checked-in dist, so a regression that reintroduces the
// static redis re-export (and thus a top-level ioredis import into driver.js) is
// caught by `pnpm run build` + this test, without needing to uninstall ioredis.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../../src/driver/memory';

const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));

describe('gatho/driver ioredis split', () => {
    it('dist/driver.js contains no ioredis reference', () => {
        const bundle = readFileSync(`${distDir}driver.js`, 'utf-8');
        expect(bundle).not.toMatch(/ioredis/);
    });

    it('dist/driver-redis.js imports ioredis (external)', () => {
        const bundle = readFileSync(`${distDir}driver-redis.js`, 'utf-8');
        expect(bundle).toMatch(/ioredis/);
    });

    it('the memory driver is usable without touching redis', () => {
        // importing from the driver source graph (no ioredis) and using it must
        // work — this is the memory-only install path.
        const driver = createMemoryDriver();
        expect(driver._internal.local).toBe(true);
        driver.destroy?.();
    });
});
