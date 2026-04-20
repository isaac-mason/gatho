import { describe, it, expect, vi } from 'vitest';
import { runner } from '../../src/server/runner/runner';
import type { SpawnContext } from '../../src/server/runner/types';

function makeCtx(overrides?: Partial<SpawnContext>): SpawnContext {
    return {
        roomId: 'room-1',
        roomType: 'game',
        serverId: 'server-1',
        roomSecret: 'secret-abc',
        data: {},
        socket: '/tmp/gatho-ipc/room-1.sock',
        ...overrides,
    };
}

describe('runner ctx.env', () => {
    it('provides all five standard gatho env vars', () => {
        runner((ctx) => {
            expect(ctx.env).toEqual({
                GATHO_ROOM_ID: 'room-1',
                GATHO_SOCKET: '/tmp/gatho-ipc/room-1.sock',
                GATHO_ROOM_TYPE: 'game',
                GATHO_SERVER_ID: 'server-1',
                GATHO_ROOM_SECRET: 'secret-abc',
            });
            return () => {};
        }).spawn(makeCtx());
    });

    it('does not include data or extra fields', () => {
        runner((ctx) => {
            expect(Object.keys(ctx.env)).toHaveLength(5);
            expect(ctx.env).not.toHaveProperty('FOO');
            return () => {};
        }).spawn(makeCtx({ data: { FOO: 'bar' } }));
    });
});

describe('runner', () => {
    it('calls spawn function with context and stopped callback', () => {
        const spawnFn = vi.fn(() => () => {});
        const r = runner(spawnFn);
        const ctx = makeCtx();

        r.spawn(ctx);

        expect(spawnFn).toHaveBeenCalledOnce();
        const received = spawnFn.mock.calls[0][0];
        expect(received.roomId).toBe('room-1');
        expect(received.roomType).toBe('game');
        expect(typeof received.stopped).toBe('function');
        expect(typeof received.env).toBe('object');
    });

    it('delivers stopped() to onExit handler', () => {
        const r = runner((ctx) => {
            // simulate async exit
            setTimeout(() => ctx.stopped(0), 10);
            return () => {};
        });

        const result = r.spawn(makeCtx());

        return new Promise<void>((resolve) => {
            result.onExit((code) => {
                expect(code).toBe(0);
                resolve();
            });
        });
    });

    it('delivers null exit code', () => {
        const r = runner((ctx) => {
            setTimeout(() => ctx.stopped(null), 10);
            return () => {};
        });

        const result = r.spawn(makeCtx());

        return new Promise<void>((resolve) => {
            result.onExit((code) => {
                expect(code).toBeNull();
                resolve();
            });
        });
    });

    it('buffers stopped() if called before onExit is registered', () => {
        const r = runner((ctx) => {
            // stopped fires synchronously during spawn
            ctx.stopped(42);
            return () => {};
        });

        const result = r.spawn(makeCtx());

        // onExit registered after stopped was already called
        const handler = vi.fn();
        result.onExit(handler);

        expect(handler).toHaveBeenCalledWith(42);
    });

    it('only delivers stopped() once even if called multiple times', () => {
        const r = runner((ctx) => {
            ctx.stopped(1);
            ctx.stopped(2);
            ctx.stopped(3);
            return () => {};
        });

        const result = r.spawn(makeCtx());
        const handler = vi.fn();
        result.onExit(handler);

        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(1);
    });

    it('calls destructor on kill()', () => {
        const destructor = vi.fn();
        const r = runner(() => destructor);

        const result = r.spawn(makeCtx());
        expect(destructor).not.toHaveBeenCalled();

        result.kill();
        expect(destructor).toHaveBeenCalledOnce();
    });

    it('supports async spawn — destructor available after resolution', async () => {
        const destructor = vi.fn();

        let resolveSpawn!: (d: () => void) => void;
        const spawnPromise = new Promise<() => void>((r) => {
            resolveSpawn = r;
        });

        const r = runner(() => spawnPromise);
        const result = r.spawn(makeCtx());

        // kill before destructor is available — should queue
        result.kill();
        expect(destructor).not.toHaveBeenCalled();

        // resolve the spawn — queued kill should fire
        resolveSpawn(destructor);
        await spawnPromise;

        expect(destructor).toHaveBeenCalledOnce();
    });

    it('supports async destructor', async () => {
        let destroyed = false;

        const r = runner(() => {
            return async () => {
                await new Promise((r) => setTimeout(r, 10));
                destroyed = true;
            };
        });

        const result = r.spawn(makeCtx());
        const p = result.kill();

        // kill() returns void (fire-and-forget from server perspective)
        expect(p).toBeUndefined();

        // but the async work still runs
        await new Promise((r) => setTimeout(r, 50));
        expect(destroyed).toBe(true);
    });

    it('async spawn with stopped() before resolution — buffers correctly', async () => {
        let stoppedFn!: (code: number | null) => void;

        const r = runner(async (ctx) => {
            stoppedFn = ctx.stopped;
            await new Promise((r) => setTimeout(r, 10));
            return () => {};
        });

        const result = r.spawn(makeCtx());

        // stopped fires before spawn resolves
        stoppedFn(99);

        const handler = vi.fn();
        result.onExit(handler);

        expect(handler).toHaveBeenCalledWith(99);
    });
});
