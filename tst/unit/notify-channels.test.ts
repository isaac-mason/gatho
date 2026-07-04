import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type NetConnectOpts, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeNotifyFrame, encodeRawFrame, type NotifyMessage } from '../../src/common/notify-protocol';
import { notify } from '../../src/server/runner/notify';
import type { SpawnContext } from '../../src/server/runner/types';

// --- fakes & helpers ---

type Ctx = SpawnContext & { onMessage: ReturnType<typeof vi.fn> };

function makeCtx(): Ctx {
    return {
        roomId: 'r1',
        roomType: 'game',
        serverId: 's1',
        roomSecret: 'sec',
        data: {},
        onMessage: vi.fn(),
        stopped: vi.fn(),
        status: () => 'starting',
    } as unknown as Ctx;
}

// sockets and channel-closers opened during a test, torn down in afterEach.
const openSockets: Socket[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
    for (const s of openSockets) s.destroy();
    openSockets.length = 0;
    for (const c of closers) {
        try {
            c();
        } catch {
            // ignore
        }
    }
    closers.length = 0;
});

/** dial a socket, resolve on connect, reject on the first error. */
function dial(opts: NetConnectOpts): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const s = createConnection(opts);
        openSockets.push(s);
        s.once('error', reject);
        s.once('connect', () => {
            s.removeListener('error', reject);
            // swallow later resets (server destroys the peer on close/reject)
            s.on('error', () => {});
            resolve(s);
        });
    });
}

function tokenFrame(token: string): Uint8Array {
    return encodeRawFrame(new TextEncoder().encode(token));
}

async function waitUntil(pred: () => boolean, deadlineMs = 1500, stepMs = 10): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, stepMs));
    }
    return pred();
}

function waitForClose(s: Socket): Promise<void> {
    return new Promise((resolve) => s.once('close', () => resolve()));
}

const READY: NotifyMessage = { type: 'ready', port: 1234 };

// --- tcp ---

describe('notify.tcp channel', () => {
    it('happy path: token frame then a message reaches ctx.onMessage', async () => {
        const ctx = makeCtx();
        const chan = await notify.tcp(ctx);
        closers.push(chan.close);

        // uri carries the port and token
        expect(chan.env.GATHO_NOTIFY_SOCKET).toBe(`tcp://127.0.0.1:${chan.port}?token=${chan.token}`);

        const s = await dial({ host: '127.0.0.1', port: chan.port });
        s.write(tokenFrame(chan.token));
        s.write(encodeNotifyFrame(READY));

        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 1)).toBe(true);
        expect(ctx.onMessage).toHaveBeenCalledWith(READY);
    });

    it('wrong token → socket destroyed, onMessage never called', async () => {
        const ctx = makeCtx();
        const chan = await notify.tcp(ctx);
        closers.push(chan.close);

        const s = await dial({ host: '127.0.0.1', port: chan.port });
        const closed = waitForClose(s);
        s.write(tokenFrame('not-the-token'));
        s.write(encodeNotifyFrame(READY));

        await closed; // server destroys the connection
        // give any (erroneous) delivery a chance to land, then assert none did
        await new Promise((r) => setTimeout(r, 50));
        expect(ctx.onMessage).not.toHaveBeenCalled();
    });

    it('token and message concatenated in one write → both handled', async () => {
        const ctx = makeCtx();
        const chan = await notify.tcp(ctx);
        closers.push(chan.close);

        const s = await dial({ host: '127.0.0.1', port: chan.port });
        const combined = new Uint8Array([...tokenFrame(chan.token), ...encodeNotifyFrame(READY)]);
        s.write(combined);

        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 1)).toBe(true);
        expect(ctx.onMessage).toHaveBeenCalledWith(READY);
    });

    it('token split across two writes (partial frame) → still authenticates', async () => {
        const ctx = makeCtx();
        const chan = await notify.tcp(ctx);
        closers.push(chan.close);

        const s = await dial({ host: '127.0.0.1', port: chan.port });
        const frame = tokenFrame(chan.token);
        const mid = Math.floor(frame.byteLength / 2);
        s.write(frame.subarray(0, mid));
        await new Promise((r) => setTimeout(r, 20));
        s.write(frame.subarray(mid));
        s.write(encodeNotifyFrame(READY));

        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 1)).toBe(true);
        expect(ctx.onMessage).toHaveBeenCalledWith(READY);
    });

    it('second connection while first is active → rejected, first keeps working', async () => {
        const ctx = makeCtx();
        const chan = await notify.tcp(ctx);
        closers.push(chan.close);

        // conn1 authenticates and delivers a message
        const s1 = await dial({ host: '127.0.0.1', port: chan.port });
        s1.write(tokenFrame(chan.token));
        s1.write(encodeNotifyFrame(READY));
        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 1)).toBe(true);

        // conn2 presents the valid token but loses the active slot → rejected
        const s2 = await dial({ host: '127.0.0.1', port: chan.port });
        const closed2 = waitForClose(s2);
        s2.write(tokenFrame(chan.token));
        s2.write(encodeNotifyFrame({ type: 'stopped' }));
        await closed2;
        await new Promise((r) => setTimeout(r, 50));
        expect(ctx.onMessage.mock.calls.length).toBe(1); // conn2's message did NOT land

        // conn1 still works
        s1.write(encodeNotifyFrame({ type: 'client-disconnected', clientId: 'x' }));
        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 2)).toBe(true);
    });

    it('drop first connection then redial with token → accepted', async () => {
        const ctx = makeCtx();
        const chan = await notify.tcp(ctx);
        closers.push(chan.close);

        const s1 = await dial({ host: '127.0.0.1', port: chan.port });
        s1.write(tokenFrame(chan.token));
        s1.write(encodeNotifyFrame(READY));
        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 1)).toBe(true);

        // drop conn1, let the server release the active slot
        s1.destroy();
        await new Promise((r) => setTimeout(r, 100));

        const s2 = await dial({ host: '127.0.0.1', port: chan.port });
        s2.write(tokenFrame(chan.token));
        s2.write(encodeNotifyFrame({ type: 'stopped' }));
        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 2)).toBe(true);
        expect(ctx.onMessage).toHaveBeenLastCalledWith({ type: 'stopped' });
    });

    it('after chan.close() the listener refuses connections and delivers nothing', async () => {
        const ctx = makeCtx();
        const chan = await notify.tcp(ctx);
        const port = chan.port;
        chan.close();

        await expect(dial({ host: '127.0.0.1', port })).rejects.toBeTruthy();
        expect(ctx.onMessage).not.toHaveBeenCalled();
    });
});

// --- uds ---

describe('notify.uds channel', () => {
    let tmp: string | null = null;

    afterEach(() => {
        if (tmp) {
            rmSync(tmp, { recursive: true, force: true });
            tmp = null;
        }
    });

    it('happy path: a framed message reaches ctx.onMessage', async () => {
        tmp = mkdtempSync(join(tmpdir(), 'gatho-uds-'));
        const ctx = makeCtx();
        const chan = await notify.uds(ctx, { socketDir: tmp });
        closers.push(chan.close);

        expect(chan.env.GATHO_NOTIFY_SOCKET).toBe(`uds:${chan.socketPath}`);

        const s = await dial({ path: chan.socketPath });
        s.write(encodeNotifyFrame(READY));

        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 1)).toBe(true);
        expect(ctx.onMessage).toHaveBeenCalledWith(READY);
    });

    it('redial after drop works', async () => {
        tmp = mkdtempSync(join(tmpdir(), 'gatho-uds-'));
        const ctx = makeCtx();
        const chan = await notify.uds(ctx, { socketDir: tmp });
        closers.push(chan.close);

        const s1 = await dial({ path: chan.socketPath });
        s1.write(encodeNotifyFrame(READY));
        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 1)).toBe(true);

        s1.destroy();
        await new Promise((r) => setTimeout(r, 100));

        const s2 = await dial({ path: chan.socketPath });
        s2.write(encodeNotifyFrame({ type: 'stopped' }));
        expect(await waitUntil(() => ctx.onMessage.mock.calls.length === 2)).toBe(true);
    });

    it('close() removes the socket file and the per-room directory', async () => {
        tmp = mkdtempSync(join(tmpdir(), 'gatho-uds-'));
        const ctx = makeCtx();
        const chan = await notify.uds(ctx, { socketDir: tmp });

        expect(existsSync(chan.socketPath)).toBe(true);
        expect(existsSync(chan.socketDir)).toBe(true);

        chan.close();

        expect(existsSync(chan.socketPath)).toBe(false);
        expect(existsSync(chan.socketDir)).toBe(false);
        // the outer socketDir the caller supplied is left intact
        expect(existsSync(tmp)).toBe(true);
    });
});

// --- direct ---

describe('notify.direct channel', () => {
    it('notifier.send delivers to ctx.onMessage synchronously', () => {
        const ctx = makeCtx();
        const chan = notify.direct(ctx);

        chan.notifier.send(READY);
        // synchronous — no await, already delivered
        expect(ctx.onMessage).toHaveBeenCalledTimes(1);
        expect(ctx.onMessage).toHaveBeenCalledWith(READY);
    });

    it('after chan.close() sends are dropped', () => {
        const ctx = makeCtx();
        const chan = notify.direct(ctx);

        chan.notifier.send(READY);
        chan.close();
        chan.notifier.send({ type: 'stopped' });

        expect(ctx.onMessage).toHaveBeenCalledTimes(1);
        expect(ctx.onMessage).toHaveBeenCalledWith(READY);
    });

    it('after notifier.close() sends are dropped', () => {
        const ctx = makeCtx();
        const chan = notify.direct(ctx);

        chan.notifier.send(READY);
        chan.notifier.close();
        chan.notifier.send({ type: 'stopped' });

        expect(ctx.onMessage).toHaveBeenCalledTimes(1);
    });
});
