// driver setup definitions for e2e tests
import Redis from 'ioredis';
import { createMemoryDriver } from 'gatho/driver';
import type { Driver } from 'gatho/driver';
import { createRedisDriver } from 'gatho/driver/redis';

export type DriverSetup = {
    name: string;
    tags: string[];
    create: () => Promise<{ driver: Driver; teardown: () => Promise<void> }>;
};

export const memoryDriverSetup: DriverSetup = {
    name: 'memory',
    tags: ['any'],
    create: async () => ({
        driver: createMemoryDriver(),
        teardown: async () => {},
    }),
};

export const redisDriverSetup: DriverSetup = {
    name: 'redis',
    tags: ['any', 'ha'],
    create: async () => {
        const url = process.env.GATHO_TEST_REDIS_URL ?? 'redis://localhost:16379';
        const client = new Redis(url);

        // flush test db
        await client.flushdb();

        const d = createRedisDriver({ client });
        return {
            driver: d,
            teardown: async () => {
                await client.flushdb();
                client.disconnect();
            },
        };
    },
};

export const allDrivers: DriverSetup[] = [memoryDriverSetup, redisDriverSetup];
