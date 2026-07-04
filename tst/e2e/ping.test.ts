// ping endpoint test — verifies GET /ping returns 200 'pong'
// also verifies ServerInfo.endpoint is a fully-qualified URL usable for ping

import { createMemoryDriver } from 'gatho/driver';
import { createGathoSDK } from 'gatho/sdk';
import type { Server } from 'gatho/server';
import { start, subprocess } from 'gatho/server';
import { afterEach, describe, expect, it } from 'vitest';
import { roomScripts } from './helpers';

describe('/ping endpoint', () => {
    let server: Server | null = null;

    afterEach(async () => {
        if (server) {
            await server.stop();
            server = null;
        }
    });

    it('returns 200 with body "pong"', async () => {
        const driver = createMemoryDriver();

        server = await start({
            rooms: {
                echo: subprocess(['bun', 'run', roomScripts.echo]),
            },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
        });

        const addr = server.address();
        expect(addr).not.toBeNull();

        const res = await fetch(`http://127.0.0.1:${addr!.port}/ping`);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/plain');
        expect(await res.text()).toBe('pong');
    });

    it('responds fast (< 50ms)', async () => {
        const driver = createMemoryDriver();

        server = await start({
            rooms: {
                echo: subprocess(['bun', 'run', roomScripts.echo]),
            },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
        });

        const addr = server.address();
        expect(addr).not.toBeNull();

        const startTime = performance.now();
        await fetch(`http://127.0.0.1:${addr!.port}/ping`);
        const elapsed = performance.now() - startTime;

        expect(elapsed).toBeLessThan(50);
    });

    it('ServerInfo.endpoint is a fully-qualified URL usable for /ping', async () => {
        const driver = createMemoryDriver();
        const sdk = createGathoSDK({ driver });

        server = await start({
            rooms: {
                echo: subprocess(['bun', 'run', roomScripts.echo]),
            },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
        });

        const servers = await sdk.getServers();
        expect(servers).toHaveLength(1);

        const endpoint = servers[0].endpoint;

        // endpoint should be a fully-qualified http URL
        expect(endpoint).toMatch(/^https?:\/\//);

        // should be usable directly for /ping
        const res = await fetch(`${endpoint}/ping`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('pong');
    });

    it('serverEndpoint option overrides the default', async () => {
        const driver = createMemoryDriver();
        const sdk = createGathoSDK({ driver });

        server = await start({
            rooms: {
                echo: subprocess(['bun', 'run', roomScripts.echo]),
            },
            driver,
            roomEndpoint: (info) => `ws://127.0.0.1:${info.port}`,
            port: 0,
            tags: {},
            serverEndpoint: 'https://us-east.example.com',
        });

        const servers = await sdk.getServers();
        expect(servers).toHaveLength(1);
        expect(servers[0].endpoint).toBe('https://us-east.example.com');
    });
});
