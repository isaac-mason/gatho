// gatho workerd host runner (example code — public API only)
//
// A `workerd({ entry })` runner factory built on gatho's public `runner()` +
// `notify.tcp()`. It manages ONE long-lived `workerd` process per gatho server
// (refcounted across room types) and instantiates one v8 isolate per room via the
// harness's admission API. Spawning a room is an HTTP POST + isolate load (~ms),
// not a process launch.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import type { NotifyMessage } from 'gatho/room';
import { type RoomRunner, runner } from 'gatho/server';
import workerdPkg from 'workerd';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKERD_BIN = (workerdPkg as unknown as { default: string }).default;
const ADAPTER = resolve(HERE, '../adapter/index.ts');
const HARNESS = resolve(HERE, '../harness/harness.ts');

const TICK_INTERVAL_MS = 1500;

// gatho/room loads its node-only deps (ws, http, node:net) lazily inside code
// paths the isolate never runs — the adapter supplies its own transport and
// Notifier. marking them external leaves inert dynamic imports in the bundle.
const NODE_EXTERNALS = ['ws', 'http', 'node:http', 'net', 'node:net'];
const WORKERD_CONDITIONS = ['workerd', 'worker', 'browser'];

// --- host singleton ---

type Host = {
    proc: ChildProcess;
    clientPort: number;
    adminPort: number;
    adminToken: string;
    refcount: number;
    tick: ReturnType<typeof setInterval>;
    // resident rooms: roomId -> stopped sink, so a host crash reports every room exited.
    resident: Map<string, (code: number | null) => void>;
    // forget this host as the singleton (idempotent) — new spawns bring up a fresh one.
    markGone(): void;
};

// singleton guard: the IN-FLIGHT promise is cached, not the resolved host, so
// (a) concurrent first spawns share one bring-up instead of racing two workerd
// processes, and (b) a failed bring-up is discarded (the catch clears the slot)
// rather than poisoning every future spawn.
let hostPromise: Promise<Host> | null = null;
let harnessBundle: string | null = null;
const roomBundleCache = new Map<string, string>();

async function bundleHarness(): Promise<string> {
    if (harnessBundle) return harnessBundle;
    const out = await esbuild.build({
        entryPoints: [HARNESS],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        conditions: WORKERD_CONDITIONS,
        external: ['cloudflare:sockets', 'cloudflare:workers', ...NODE_EXTERNALS],
        write: false,
        logLevel: 'silent',
    });
    harnessBundle = out.outputFiles[0].text;
    return harnessBundle;
}

async function bundleRoom(entryPath: string): Promise<string> {
    const cached = roomBundleCache.get(entryPath);
    if (cached) return cached;
    // generated entry: wrap the room factory module (default export) in the adapter.
    const stub = `
import def from ${JSON.stringify(entryPath)};
import { createWorkerdRoom } from ${JSON.stringify(ADAPTER)};
export default createWorkerdRoom(def);
`;
    const out = await esbuild.build({
        stdin: { contents: stub, resolveDir: HERE, loader: 'ts' },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        conditions: WORKERD_CONDITIONS,
        external: NODE_EXTERNALS,
        write: false,
        logLevel: 'silent',
    });
    const js = out.outputFiles[0].text;
    roomBundleCache.set(entryPath, js);
    return js;
}

// A per-room loopback listener speaking newline-delimited JSON (line 0 = auth
// token). This replaces `notify.tcp()`: the isolate can't produce gatho's packcat
// frames (workerd forbids the `new Function` codegen packcat uses), so the harness
// relays plain JSON and we decode it here and feed `ctx.onMessage` directly.
type JsonNotifyChannel = { uri: string; close(): void };

function jsonNotifyListener(onMessage: (msg: NotifyMessage) => void): Promise<JsonNotifyChannel> {
    const token = randomBytes(16).toString('hex');
    return new Promise((res, rej) => {
        const server = createServer((socket) => {
            let authed = false;
            let buf = '';
            socket.on('error', () => {});
            socket.on('data', (chunk: Buffer) => {
                buf += chunk.toString('utf8');
                let nl: number;
                // biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitter
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (line.length === 0) continue;
                    if (!authed) {
                        if (line !== token) {
                            socket.destroy();
                            return;
                        }
                        authed = true;
                        continue;
                    }
                    try {
                        onMessage(JSON.parse(line) as NotifyMessage);
                    } catch {
                        /* drop malformed line */
                    }
                }
            });
        });
        server.on('error', rej);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                server.close();
                rej(new Error('could not bind notify listener'));
                return;
            }
            res({
                uri: `tcp://127.0.0.1:${addr.port}?token=${token}`,
                close: () => server.close(),
            });
        });
    });
}

function getFreePort(): Promise<number> {
    return new Promise((res, rej) => {
        const srv = createServer();
        srv.on('error', rej);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') {
                const port = addr.port;
                srv.close(() => res(port));
            } else {
                srv.close();
                rej(new Error('could not allocate port'));
            }
        });
    });
}

function generateConfig(clientPort: number, adminPort: number, adminToken: string): string {
    return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "harness",
      worker = (
        modules = [ (name = "harness.js", esModule = embed "harness.js") ],
        compatibilityDate = "2025-05-01",
        compatibilityFlags = ["nodejs_compat", "enable_ctx_exports", "experimental"],
        bindings = [
          (name = "LOADER", workerLoader = ()),
          (name = "ADMIN_TOKEN", text = ${JSON.stringify(adminToken)}),
        ],
        globalOutbound = (name = "loopback"),
      )
    ),
    ( name = "loopback", network = ( allow = ["public", "private", "local"] ) ),
  ],
  sockets = [
    ( name = "client", address = "127.0.0.1:${clientPort}", http = (), service = "harness" ),
    ( name = "admin", address = "127.0.0.1:${adminPort}", http = (), service = (name = "harness", entrypoint = "Admin") ),
  ],
);
`;
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((res, rej) => {
        const attempt = () => {
            const sock = createConnection({ host: '127.0.0.1', port }, () => {
                sock.destroy();
                res();
            });
            sock.on('error', () => {
                sock.destroy();
                if (Date.now() > deadline) rej(new Error(`workerd admin socket ${port} not ready in ${timeoutMs}ms`));
                else setTimeout(attempt, 100);
            });
        };
        attempt();
    });
}

function ensureHost(): Promise<Host> {
    if (!hostPromise) {
        const self: Promise<Host> = bringUpHost(() => {
            if (hostPromise === self) hostPromise = null;
        }).catch((err) => {
            if (hostPromise === self) hostPromise = null;
            throw err;
        });
        hostPromise = self;
    }
    return hostPromise;
}

async function bringUpHost(markGone: () => void): Promise<Host> {
    const clientPort = await getFreePort();
    const adminPort = await getFreePort();
    const adminToken = randomBytes(16).toString('hex');

    const harnessJs = await bundleHarness();
    const configText = generateConfig(clientPort, adminPort, adminToken);

    const dir = mkdtempSync(join(tmpdir(), 'gatho-workerd-'));
    writeFileSync(join(dir, 'harness.js'), harnessJs);
    writeFileSync(join(dir, 'config.capnp'), configText);

    const proc = spawn(WORKERD_BIN, ['serve', 'config.capnp', '--experimental'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    prefixOutput(proc);

    const resident = new Map<string, (code: number | null) => void>();

    const tick = setInterval(() => {
        fetch(`http://127.0.0.1:${adminPort}/__gatho/tick`, {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}` },
        }).catch(() => {
            /* transient — next tick retries */
        });
    }, TICK_INTERVAL_MS);
    tick.unref?.();

    proc.on('exit', (code) => {
        // host down — report every resident room exited so the driver reschedules.
        for (const stopped of resident.values()) stopped(code);
        resident.clear();
        clearInterval(tick);
        markGone();
    });

    try {
        await waitForPort(adminPort, 15_000);
    } catch (err) {
        // bring-up failed with the child possibly still alive (bound but hung,
        // or never bound) — reclaim it now; ensureHost's catch discards this
        // attempt so the next spawn starts fresh.
        clearInterval(tick);
        proc.kill('SIGKILL');
        throw err;
    }

    return { proc, clientPort, adminPort, adminToken, refcount: 0, tick, resident, markGone };
}

function teardownHost(h: Host): void {
    clearInterval(h.tick);
    // forget the singleton immediately — don't let a spawn racing the SIGTERM
    // adopt a dying host in the window before 'exit' fires.
    h.markGone();
    h.proc.kill('SIGTERM');
}

function prefixOutput(proc: ChildProcess): void {
    const pipe = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream) => {
        if (!stream) return;
        let buf = '';
        stream.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) out.write(`\x1b[2m[workerd]\x1b[0m ${line}\n`);
        });
    };
    pipe(proc.stdout, process.stdout);
    pipe(proc.stderr, process.stderr);
}

// --- the runner factory ---

export type WorkerdRunnerOptions = {
    /** path to the room module — default-exports a `RoomModule` factory
     *  `(room) => options`. resolved against cwd. */
    entry: string;
};

/**
 * Build a gatho `RoomRunner` that hosts rooms of one type as workerd isolates.
 * All room types passed to one `start()` share a single workerd process.
 */
export function workerd(options: WorkerdRunnerOptions): RoomRunner {
    const entryPath = resolve(process.cwd(), options.entry);

    return runner(async (ctx) => {
        const h = await ensureHost();
        h.refcount++;

        // notify channel: a per-room loopback JSON-line listener. decoded messages
        // go straight into the server's message handler for this room.
        const chan = await jsonNotifyListener((msg) => ctx.onMessage(msg));
        const bundleJs = await bundleRoom(entryPath);

        h.resident.set(ctx.roomId, ctx.stopped);

        const res = await fetch(`http://127.0.0.1:${h.adminPort}/rooms/${encodeURIComponent(ctx.roomId)}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                bundleJs,
                notifyUri: chan.uri,
                roomSecret: ctx.roomSecret,
                roomType: ctx.roomType,
                serverId: ctx.serverId,
                clientPort: h.clientPort,
            }),
        });
        if (!res.ok) {
            h.resident.delete(ctx.roomId);
            chan.close();
            h.refcount--;
            // this room never ran — if it was the only reason the host existed,
            // reclaim the workerd process too (the destructor below won't run
            // for a spawn that threw).
            if (h.refcount <= 0) teardownHost(h);
            throw new Error(`admission failed: ${res.status} ${await res.text().catch(() => '')}`);
        }

        // destructor
        return async () => {
            h.resident.delete(ctx.roomId);
            try {
                await fetch(`http://127.0.0.1:${h.adminPort}/rooms/${encodeURIComponent(ctx.roomId)}`, {
                    method: 'DELETE',
                    headers: { authorization: `Bearer ${h.adminToken}` },
                });
            } catch {
                /* host may already be gone */
            }
            chan.close();
            h.refcount--;
            if (h.refcount <= 0) teardownHost(h);
        };
    });
}
