import { describe, expect, it, vi } from 'vitest';
import type { NotifyMessage } from '../../src/common/notify-protocol';
import { type RunnerSpawnFn, runner } from '../../src/server/runner/runner';
import type { SpawnContext } from '../../src/server/runner/types';

// build a spawn context with spy callbacks. `onMessage` and `stopped` are the
// server's two handlers handed to the runner — the runner feeds room speech to
// `onMessage` and reports exit via `stopped`. both are `vi.fn()` spies, so
// tests can assert on them directly.
function makeCtx(overrides?: Partial<SpawnContext>): SpawnContext {
    return {
        roomId: 'room-1',
        roomType: 'game',
        serverId: 'server-1',
        roomSecret: 'secret-abc',
        data: {},
        onMessage: vi.fn() as (msg: NotifyMessage) => void,
        stopped: vi.fn(),
        status: () => 'starting' as const,
        ...overrides,
    };
}

describe('runner ctx.env', () => {
    it('provides the four standard gatho env vars — no GATHO_SOCKET', () => {
        runner((ctx) => {
            expect(ctx.env).toEqual({
                GATHO_ROOM_ID: 'room-1',
                GATHO_ROOM_TYPE: 'game',
                GATHO_SERVER_ID: 'server-1',
                GATHO_ROOM_SECRET: 'secret-abc',
            });
            // the notify channel contributes GATHO_SOCKET / GATHO_NOTIFY_SOCKET, not ctx.env
            expect(ctx.env).not.toHaveProperty('GATHO_SOCKET');
            expect(ctx.env).not.toHaveProperty('GATHO_NOTIFY_SOCKET');
            return () => {};
        }).spawn(makeCtx());
    });

    it('does not include data or extra fields', () => {
        runner((ctx) => {
            expect(Object.keys(ctx.env)).toHaveLength(4);
            expect(ctx.env).not.toHaveProperty('FOO');
            return () => {};
        }).spawn(makeCtx({ data: { FOO: 'bar' } }));
    });
});

describe('runner', () => {
    it('calls spawn function with context and the injected sinks', () => {
        const spawnFn = vi.fn<RunnerSpawnFn>(() => () => {});
        const r = runner(spawnFn);
        const ctx = makeCtx();

        r.spawn(ctx);

        expect(spawnFn).toHaveBeenCalledOnce();
        const received = spawnFn.mock.calls[0]![0];
        expect(received.roomId).toBe('room-1');
        expect(received.roomType).toBe('game');
        expect(typeof received.stopped).toBe('function');
        expect(typeof received.onMessage).toBe('function');
        expect(typeof received.env).toBe('object');
    });

    it('calls destructor on kill() (sync spawn)', () => {
        const destructor = vi.fn();
        const r = runner(() => destructor);

        const result = r.spawn(makeCtx());
        expect(destructor).not.toHaveBeenCalled();

        result.kill();
        expect(destructor).toHaveBeenCalledOnce();
    });

    it('passes ctx.stopped through to the server core sink', () => {
        const ctx = makeCtx();
        const r = runner((c) => {
            // simulate the room exiting during setup
            c.stopped(0);
            return () => {};
        });

        r.spawn(ctx);

        expect(ctx.stopped).toHaveBeenCalledOnce();
        expect(ctx.stopped).toHaveBeenCalledWith(0);
    });

    it('passes a null exit code through to stopped', () => {
        const ctx = makeCtx();
        runner((c) => {
            c.stopped(null);
            return () => {};
        }).spawn(ctx);

        expect(ctx.stopped).toHaveBeenCalledWith(null);
    });

    it('supports async spawn — queued kill fires once the destructor resolves', async () => {
        const destructor = vi.fn();

        let resolveSpawn!: (d: () => void) => void;
        const spawnPromise = new Promise<() => void>((res) => {
            resolveSpawn = res;
        });

        const r = runner(() => spawnPromise);
        const result = r.spawn(makeCtx());

        // kill before the destructor is available — should queue
        result.kill();
        expect(destructor).not.toHaveBeenCalled();

        // resolve the spawn — the queued kill should fire the destructor
        resolveSpawn(destructor);
        await spawnPromise;
        // allow the .then() microtask to run
        await Promise.resolve();

        expect(destructor).toHaveBeenCalledOnce();
    });

    it('supports async destructor — kill() is fire-and-forget', async () => {
        let destroyed = false;

        const r = runner(() => {
            return async () => {
                await new Promise((res) => setTimeout(res, 10));
                destroyed = true;
            };
        });

        const result = r.spawn(makeCtx());
        const p = result.kill();

        // kill() returns void from the server's perspective
        expect(p).toBeUndefined();

        // the async teardown still runs
        await new Promise((res) => setTimeout(res, 50));
        expect(destroyed).toBe(true);
    });

    it('async spawn rejection synthesizes an error notify then stopped(null)', async () => {
        const ctx = makeCtx();
        const r = runner(async () => {
            throw new Error('boom: spawn failed');
        });

        r.spawn(ctx);

        // let the rejection handler run
        await new Promise((res) => setTimeout(res, 0));

        expect(ctx.onMessage).toHaveBeenCalledOnce();
        expect(ctx.onMessage).toHaveBeenCalledWith({ type: 'error', message: 'boom: spawn failed' });
        expect(ctx.stopped).toHaveBeenCalledOnce();
        expect(ctx.stopped).toHaveBeenCalledWith(null);
    });

    it('async spawn rejection with a non-Error stringifies the cause', async () => {
        const ctx = makeCtx();
        runner(async () => {
            throw 'plain string failure';
        }).spawn(ctx);

        await new Promise((res) => setTimeout(res, 0));

        expect(ctx.onMessage).toHaveBeenCalledWith({ type: 'error', message: 'plain string failure' });
        expect(ctx.stopped).toHaveBeenCalledWith(null);
    });
});
