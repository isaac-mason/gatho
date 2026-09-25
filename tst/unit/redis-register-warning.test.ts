import Redis, { Cluster } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedisDriver } from '../../src/driver/redis';

function captureStdout(): { lines: () => string[]; restore: () => void } {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
        lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return write(chunk, ...(rest as []));
    });
    return { lines: () => lines, restore: () => spy.mockRestore() };
}

const warning = 'room assigned but server not subscribed';

// never connected: the register script's reply is stubbed to "published to 0 subscribers"
describe('assignment published to no subscriber', () => {
    const restores: (() => void)[] = [];

    afterEach(() => {
        for (const restore of restores) restore();
        restores.length = 0;
    });

    it('is logged for a standalone client, where 0 receivers means nobody is listening', async () => {
        const client = new Redis({ lazyConnect: true });
        vi.spyOn(client, 'eval').mockResolvedValue(0);
        const logs = captureStdout();
        restores.push(() => logs.restore());

        await createRedisDriver({ client })._internal.registerRoom('room-1', 'echo', 'srv-1', {}, {}, 1_000);

        expect(logs.lines().some((line) => line.includes(warning))).toBe(true);
    });

    it('is not logged for a cluster client, where PUBLISH counts only the executing node', async () => {
        const client = new Cluster([{ host: '127.0.0.1', port: 1 }], { lazyConnect: true });
        vi.spyOn(client, 'eval').mockResolvedValue(0);
        const logs = captureStdout();
        restores.push(() => logs.restore());

        await createRedisDriver({ client })._internal.registerRoom('room-1', 'echo', 'srv-1', {}, {}, 1_000);

        expect(logs.lines().some((line) => line.includes(warning))).toBe(false);
    });
});
