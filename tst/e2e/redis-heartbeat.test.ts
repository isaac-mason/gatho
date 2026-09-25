import { createRedisDriver } from 'gatho/driver/redis';
import Redis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

const redisUrl = new URL(process.env.GATHO_TEST_REDIS_URL ?? 'redis://localhost:16379');
// own db and prefix: other e2e files flushdb theirs, and pub/sub channels span dbs
const db = 3;
const prefix = 'heartbeat:{heartbeat}:';

describe('redis heartbeat registration', () => {
    const cleanups: (() => void)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.reverse()) cleanup();
        cleanups.length = 0;
        const admin = new Redis(Number(redisUrl.port), redisUrl.hostname, { db });
        await admin.flushdb();
        admin.disconnect();
    });

    it('reports registered when a reap lands between the heartbeat reading and writing the record', async () => {
        const client = new Redis(Number(redisUrl.port), redisUrl.hostname, { db });
        const driver = createRedisDriver({ client, prefix });
        cleanups.push(() => {
            driver.destroy?.();
            client.disconnect();
        });
        const options = { serverId: 'srv-1', endpoint: 'http://127.0.0.1:1', tags: {}, roomTypes: ['echo'] };
        await driver._internal.heartbeat(options);

        // the reap runs immediately before the heartbeat's write transaction executes
        const multi = client.multi.bind(client);
        vi.spyOn(client, 'multi').mockImplementationOnce(() => {
            const transaction = multi();
            const exec = transaction.exec.bind(transaction);
            transaction.exec = async () => {
                await driver._internal.unregisterServer('srv-1');
                return exec();
            };
            return transaction;
        });

        const { registered } = await driver._internal.heartbeat(options);

        // not registered here means reap-recovery is skipped and the destroy sweep kills every room
        expect(registered).toBe(true);
    });
});
