import { createMemoryDriver } from 'gatho/driver';
import { start, subprocess } from 'gatho/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomScripts, sleep, waitUntil } from './helpers';

// gatho logs errors to stderr and everything else to stdout
function captureLogLines(): { lines: () => string[]; restore: () => void } {
    const lines: string[] = [];
    const spies = [process.stdout, process.stderr].map((stream) => {
        const write = stream.write.bind(stream);
        return vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
            lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
            return write(chunk, ...(rest as []));
        });
    });
    return { lines: () => lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

describe('driver heartbeat outage', () => {
    const cleanups: (() => Promise<void> | void)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        cleanups.length = 0;
    });

    it('names a driver heartbeat outage once, and its recovery', async () => {
        const driver = createMemoryDriver();
        cleanups.push(() => driver.destroy?.());
        const server = await start({
            rooms: { echo: subprocess(['bun', 'run', roomScripts.echo]) },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            host: '127.0.0.1',
            port: 0,
            heartbeatIntervalMs: 100,
        });
        cleanups.push(() => server.stop());
        const logs = captureLogLines();
        cleanups.push(() => logs.restore());

        let failing = true;
        const heartbeat = driver._internal.heartbeat.bind(driver._internal);
        driver._internal.heartbeat = async (options) => {
            if (failing) throw new Error('driver unreachable');
            return heartbeat(options);
        };
        const count = (msg: string) => logs.lines().filter((line) => line.includes(`"msg":"${msg}"`)).length;

        await waitUntil(async () => count('driver heartbeat failing') > 0, 3_000);
        // many more failed ticks, still one outage line
        await sleep(1_000);
        expect(count('driver heartbeat failing')).toBe(1);

        failing = false;
        await waitUntil(async () => count('driver heartbeat recovered') > 0, 3_000);
        expect(count('driver heartbeat recovered')).toBe(1);
    });
});
