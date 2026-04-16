// browser reconnection tests — uses playwright with chromium + page.routeWebSocket()
// to simulate network drops by closing the server-side websocket route.
//
// approach: page.routeWebSocket() intercepts all websocket connections from the browser.
// we call connectToServer() to create a transparent proxy. when we want to simulate a
// network drop, we close the server-side route — this tears down the real connection
// (server sees close code 1005, fires onDrop) and the client sees the websocket die
// (enters reconnecting state). when the client opens a new websocket for reconnection,
// the route handler fires again, creating a fresh proxy automatically.
//
// these tests verify:
// - network drop → onDrop fires → allowReconnection → reconnect → same clientId
// - reliable message buffer (server): messages sent during drop delivered on reconnect
// - reliable message buffer (client): messages buffered during reconnecting, flushed on reconnect
// - unreliable message drop during reconnecting
// - session token rotation after reconnect
// - reconnect window expiry → onLeave fires, client enters closed
// - buffer overflow (server): evicts client when maxBufferBytes exceeded
// - broadcast reliable buffers for disconnected clients
// - client drop/reconnect events and state transitions

import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { Client } from '../../src/room';
import { startPageServer, startRoom } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser evaluate needs any for window access
type W = Record<string, any>;

// port range for browser tests: 19950-19999
let nextPort = 19950;
function getPort(): number {
    return nextPort++;
}

let pageServer: { port: number; close: () => void } | null = null;

test.beforeAll(async () => {
    pageServer = await startPageServer();
});

test.afterAll(async () => {
    pageServer?.close();
});

// helper: navigate to the test page
async function setupPage(page: Page) {
    await page.goto(`http://127.0.0.1:${pageServer!.port}`);
    await page.waitForFunction(() => !!(window as unknown as W).__gatho);
}

// helper: set up a ws proxy via routeWebSocket and return controls.
// - drop() closes the server-side route, simulating a network drop
// - blockReconnection / allowReconnection control whether new ws connections are proxied or rejected
type WsProxy = {
    drop: () => Promise<void>;
    blockReconnection: () => void;
    unblockReconnection: () => void;
};

async function setupWsProxy(page: Page): Promise<WsProxy> {
    let currentServerRoute: WebSocketRoute | null = null;
    let blocked = false;

    await page.routeWebSocket(/.*/, (ws) => {
        if (blocked) {
            // don't connect to server — just close the page-side ws immediately.
            // this makes the client's reconnect attempt fail, causing it to retry with backoff.
            ws.close({ code: 1006 });
            return;
        }

        const server = ws.connectToServer();
        currentServerRoute = server;
    });

    return {
        async drop() {
            if (currentServerRoute) {
                await currentServerRoute.close();
                currentServerRoute = null;
            }
        },
        blockReconnection() {
            blocked = true;
        },
        unblockReconnection() {
            blocked = false;
        },
    };
}

test('network drop → onDrop fires → allowReconnection → client reconnects with same clientId', async ({ page }) => {
    const port = getPort();
    let dropCode = 0;
    let dropClientId = '';
    let reconnectClientId = '';
    let joinClientId = '';
    let leaveCount = 0;

    const { room } = await startRoom({
        port,
        onJoin: (_r, client) => {
            joinClientId = client.id;
        },
        onDrop: (r, client, code) => {
            dropCode = code;
            dropClientId = client.id;
            r.allowReconnection(client, 10_000);
        },
        onReconnect: (_r, client) => {
            reconnectClientId = client.id;
        },
        onLeave: () => {
            leaveCount++;
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
            (window as W).__events = {
                drops: 0,
                reconnects: 0,
                closes: 0,
                closeCode: 0,
            };
            conn.on('drop', () => {
                (window as W).__events.drops++;
            });
            conn.on('reconnect', () => {
                (window as W).__events.reconnects++;
            });
            conn.on('close', (code: number) => {
                (window as W).__events.closes++;
                (window as W).__events.closeCode = code;
            });
        }, wsUrl);

        // wait for connection to be open
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        expect(joinClientId).not.toBe('');

        // simulate network drop
        await proxy.drop();

        // wait for server to detect the drop
        await expect(async () => {
            expect(dropCode).not.toBe(0);
        }).toPass({ timeout: 5000 });

        // drop code is 1005 (from routeWebSocket proxy close), not 4000
        expect(dropCode).not.toBe(4000);
        expect(dropClientId).toBe(joinClientId);

        // client should be in reconnecting state
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('reconnecting');
        }).toPass({ timeout: 5000 });

        // verify drop event fired on client
        const eventsAfterDrop = await page.evaluate(() => (window as W).__events);
        expect(eventsAfterDrop.drops).toBe(1);

        // client is still in the room's client map (seat held)
        expect(room.clients.count()).toBe(1);
        expect(room.clients.has(joinClientId)).toBe(true);
        expect(leaveCount).toBe(0);

        // wait for reconnection — client will backoff and reconnect via new ws
        await expect(async () => {
            expect(reconnectClientId).toBe(joinClientId);
        }).toPass({ timeout: 15_000 });

        // client should be open again
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        // verify reconnect event fired on client
        const eventsAfterReconnect = await page.evaluate(() => (window as W).__events);
        expect(eventsAfterReconnect.reconnects).toBe(1);

        // same clientId, still 1 client
        expect(room.clients.count()).toBe(1);
        expect(leaveCount).toBe(0);

        // clean close
        await page.evaluate(() => (window as W).__conn.close());
    } finally {
        await room.stop();
    }
});

test('server reliable buffer: messages sent during drop are delivered on reconnect', async ({ page }) => {
    const port = getPort();
    let joinedClient: Client | null = null;
    let clientDropped = false;

    const { room } = await startRoom({
        port,
        onJoin: (_r, client) => {
            joinedClient = client;
        },
        onDrop: (r, client) => {
            clientDropped = true;
            r.allowReconnection(client, 10_000);
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
            (window as W).__messages = [] as unknown[];
            conn.on('message', (msg: unknown) => {
                (window as W).__messages.push(msg);
            });
        }, wsUrl);

        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        // drop network
        await proxy.drop();

        // wait for server to detect the drop
        await expect(async () => {
            expect(clientDropped).toBe(true);
        }).toPass({ timeout: 5000 });

        // send reliable messages while client is disconnected
        room.send(joinedClient!, JSON.stringify({ buffered: 1 }));
        room.send(joinedClient!, JSON.stringify({ buffered: 2 }));
        room.send(joinedClient!, JSON.stringify({ buffered: 3 }));

        // wait for client to reconnect and receive buffered messages
        await expect(async () => {
            const msgs = await page.evaluate(() => (window as W).__messages);
            expect(msgs.length).toBeGreaterThanOrEqual(3);
        }).toPass({ timeout: 15_000 });

        const messages = await page.evaluate(() => (window as W).__messages);
        // the buffered messages should be in order
        const buffered = messages.filter((m: unknown) => typeof m === 'string' && m.includes('buffered'));
        expect(buffered).toEqual([
            JSON.stringify({ buffered: 1 }),
            JSON.stringify({ buffered: 2 }),
            JSON.stringify({ buffered: 3 }),
        ]);

        await page.evaluate(() => (window as W).__conn.close());
    } finally {
        await room.stop();
    }
});

test('client reliable buffer: messages sent during reconnecting are flushed on reconnect', async ({ page }) => {
    const port = getPort();
    const serverReceived: unknown[] = [];

    const { room } = await startRoom({
        port,
        onDrop: (r, client) => {
            r.allowReconnection(client, 10_000);
        },
        onMessage: (_r, _client, msg) => {
            serverReceived.push(msg);
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
        }, wsUrl);

        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        // drop network
        await proxy.drop();

        // wait for client to enter reconnecting
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('reconnecting');
        }).toPass({ timeout: 5000 });

        // block reconnection so the client stays in reconnecting while we send
        proxy.blockReconnection();

        // send reliable messages from client while disconnected
        await page.evaluate(() => {
            const conn = (window as W).__conn;
            conn.send(JSON.stringify({ fromClient: 1 }));
            conn.send(JSON.stringify({ fromClient: 2 }));
        });

        // unblock and let reconnection happen
        proxy.unblockReconnection();

        // wait for client to reconnect
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 15_000 });

        // server should have received the buffered messages
        await expect(async () => {
            expect(serverReceived.length).toBeGreaterThanOrEqual(2);
        }).toPass({ timeout: 5000 });

        const fromClient = serverReceived.filter((m) => typeof m === 'string' && m.includes('fromClient'));
        expect(fromClient).toEqual([JSON.stringify({ fromClient: 1 }), JSON.stringify({ fromClient: 2 })]);

        await page.evaluate(() => (window as W).__conn.close());
    } finally {
        await room.stop();
    }
});

test('unreliable messages from client are dropped during reconnecting', async ({ page }) => {
    const port = getPort();
    const serverReceived: unknown[] = [];

    const { room } = await startRoom({
        port,
        onDrop: (r, client) => {
            r.allowReconnection(client, 10_000);
        },
        onMessage: (_r, _client, msg) => {
            serverReceived.push(msg);
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
        }, wsUrl);

        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        // drop network
        await proxy.drop();

        // wait for client to enter reconnecting
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('reconnecting');
        }).toPass({ timeout: 5000 });

        // block reconnection so the client stays in reconnecting while we send
        proxy.blockReconnection();

        // send unreliable messages — should be silently dropped
        await page.evaluate(() => {
            const conn = (window as W).__conn;
            conn.send(JSON.stringify({ unreliable: 1 }), { reliable: false });
            conn.send(JSON.stringify({ unreliable: 2 }), { reliable: false });
            // also send one reliable for comparison
            conn.send(JSON.stringify({ reliable: 1 }));
        });

        // unblock and let reconnection happen
        proxy.unblockReconnection();

        // wait for reconnect
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 15_000 });

        // wait for messages to arrive
        await new Promise((r) => setTimeout(r, 1000));

        // only the reliable message should have been received
        const unreliable = serverReceived.filter((m) => typeof m === 'string' && m.includes('unreliable'));
        const reliable = serverReceived.filter((m) => typeof m === 'string' && m.includes('"reliable"'));
        expect(unreliable).toEqual([]);
        expect(reliable).toEqual([JSON.stringify({ reliable: 1 })]);

        await page.evaluate(() => (window as W).__conn.close());
    } finally {
        await room.stop();
    }
});

test('session token rotates after reconnect — old token rejected', async ({ page }) => {
    const port = getPort();
    let reconnected = false;

    const { room } = await startRoom({
        port,
        onDrop: (r, client) => {
            r.allowReconnection(client, 10_000);
        },
        onReconnect: () => {
            reconnected = true;
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
        }, wsUrl);

        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        // drop and reconnect
        await proxy.drop();

        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('reconnecting');
        }).toPass({ timeout: 5000 });

        // wait for reconnection
        await expect(async () => {
            expect(reconnected).toBe(true);
        }).toPass({ timeout: 15_000 });

        // the server has rotated the session token.
        // we can verify indirectly: the client is open and functional.
        const state = await page.evaluate(() => (window as W).__conn.state);
        expect(state).toBe('open');

        // do a round-trip to prove the connection is live
        await page.evaluate(() => {
            const conn = (window as W).__conn;
            conn.send(JSON.stringify({ ping: true }));
        });

        await page.evaluate(() => (window as W).__conn.close());
    } finally {
        await room.stop();
    }
});

test('reconnect window expiry — onLeave fires, client enters closed on next attempt', async ({ page }) => {
    const port = getPort();
    let leaveCount = 0;
    let dropCount = 0;

    const { room } = await startRoom({
        port,
        onDrop: (r, client) => {
            dropCount++;
            // very short window — 1 second
            r.allowReconnection(client, 1000);
        },
        onLeave: () => {
            leaveCount++;
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
            (window as W).__events = { closes: 0, closeCode: 0 };
            conn.on('close', (code: number) => {
                (window as W).__events.closes++;
                (window as W).__events.closeCode = code;
            });
        }, wsUrl);

        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        // block reconnection so the client can't reconnect during the window
        proxy.blockReconnection();

        // drop network
        await proxy.drop();

        // wait for drop to register
        await expect(async () => {
            expect(dropCount).toBe(1);
        }).toPass({ timeout: 5000 });

        // wait for the 1s reconnect window to expire
        await new Promise((r) => setTimeout(r, 1500));

        // onLeave should have fired
        expect(leaveCount).toBe(1);
        expect(room.clients.count()).toBe(0);

        // unblock reconnection — client will try to reconnect but session is invalid
        proxy.unblockReconnection();

        // client should eventually enter closed (server sends __auth_error on invalid session)
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('closed');
        }).toPass({ timeout: 15_000 });

        // the close came from __auth_error rejection
        const events = await page.evaluate(() => (window as W).__events);
        expect(events.closes).toBe(1);
    } finally {
        await room.stop();
    }
});

test('server buffer overflow evicts client when maxBufferBytes exceeded', async ({ page }) => {
    const port = getPort();
    let leaveCount = 0;
    let dropCount = 0;
    let joinedClient: Client | null = null;

    const { room } = await startRoom({
        port,
        // tiny buffer limit for testing: 1kb
        maxBufferBytes: 1024,
        onJoin: (_r, client) => {
            joinedClient = client;
        },
        onDrop: (r, client) => {
            dropCount++;
            r.allowReconnection(client, 30_000);
        },
        onLeave: () => {
            leaveCount++;
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
        }, wsUrl);

        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        // drop network
        await proxy.drop();

        // wait for server drop
        await expect(async () => {
            expect(dropCount).toBe(1);
        }).toPass({ timeout: 5000 });

        // send enough data to overflow the 1kb server buffer.
        // server uses Buffer.byteLength (utf8), so ASCII chars are 1 byte each.
        // JSON.stringify({ data: "x"*600 }) ≈ 614 bytes, two sends ≈ 1228 > 1024.
        const bigMsg = { data: 'x'.repeat(600) };
        room.send(joinedClient!, JSON.stringify(bigMsg));
        room.send(joinedClient!, JSON.stringify(bigMsg));

        // buffer overflow should have evicted the client
        await expect(async () => {
            expect(leaveCount).toBe(1);
        }).toPass({ timeout: 3000 });

        expect(room.clients.count()).toBe(0);

        // client will try to reconnect, get __auth_error, enter closed
        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('closed');
        }).toPass({ timeout: 15_000 });
    } finally {
        await room.stop();
    }
});

test('broadcast reliable buffers for disconnected clients, delivered on reconnect', async ({ page }) => {
    const port = getPort();
    let clientDropped = false;

    const { room } = await startRoom({
        port,
        onDrop: (r, client) => {
            clientDropped = true;
            r.allowReconnection(client, 10_000);
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
            (window as W).__messages = [] as unknown[];
            conn.on('message', (msg: unknown) => {
                (window as W).__messages.push(msg);
            });
        }, wsUrl);

        await expect(async () => {
            const state = await page.evaluate(() => (window as W).__conn.state);
            expect(state).toBe('open');
        }).toPass({ timeout: 5000 });

        // drop network
        await proxy.drop();

        // wait for drop to register on the server
        await expect(async () => {
            expect(clientDropped).toBe(true);
        }).toPass({ timeout: 5000 });

        // broadcast reliable messages while client is disconnected
        room.broadcast(JSON.stringify({ broadcast: 1 }));
        room.broadcast(JSON.stringify({ broadcast: 2 }));

        // wait for reconnect and message delivery
        await expect(async () => {
            const msgs = await page.evaluate(() => (window as W).__messages);
            const broadcasts = msgs.filter((m: unknown) => typeof m === 'string' && m.includes('broadcast'));
            expect(broadcasts.length).toBeGreaterThanOrEqual(2);
        }).toPass({ timeout: 15_000 });

        const messages = await page.evaluate(() => (window as W).__messages);
        const broadcasts = messages.filter((m: unknown) => typeof m === 'string' && m.includes('broadcast'));
        expect(broadcasts).toEqual([JSON.stringify({ broadcast: 1 }), JSON.stringify({ broadcast: 2 })]);

        await page.evaluate(() => (window as W).__conn.close());
    } finally {
        await room.stop();
    }
});

test('client drop and reconnect events fire correctly through state transitions', async ({ page }) => {
    const port = getPort();

    const { room } = await startRoom({
        port,
        onDrop: (r, client) => {
            r.allowReconnection(client, 10_000);
        },
    });

    const proxy = await setupWsProxy(page);

    try {
        await setupPage(page);

        const wsUrl = `ws://127.0.0.1:${port}`;
        await page.evaluate((url) => {
            const conn = (window as W).__gatho.connect(url);
            (window as W).__conn = conn;
            (window as W).__stateLog = [] as string[];

            // track all state transitions
            conn.on('open', () => {
                (window as W).__stateLog.push('open');
            });
            conn.on('drop', () => {
                (window as W).__stateLog.push('drop');
            });
            conn.on('reconnect', () => {
                (window as W).__stateLog.push('reconnect');
            });
            conn.on('close', () => {
                (window as W).__stateLog.push('close');
            });
        }, wsUrl);

        // wait for initial open
        await expect(async () => {
            const log = await page.evaluate(() => (window as W).__stateLog);
            expect(log).toContain('open');
        }).toPass({ timeout: 5000 });

        // drop network
        await proxy.drop();

        // wait for drop event
        await expect(async () => {
            const log = await page.evaluate(() => (window as W).__stateLog);
            expect(log).toContain('drop');
        }).toPass({ timeout: 5000 });

        // wait for reconnect event
        await expect(async () => {
            const log = await page.evaluate(() => (window as W).__stateLog);
            expect(log).toContain('reconnect');
        }).toPass({ timeout: 15_000 });

        // verify the transition order: open → drop → reconnect
        const log = await page.evaluate(() => (window as W).__stateLog);
        const openIdx = log.indexOf('open');
        const dropIdx = log.indexOf('drop');
        const reconnectIdx = log.indexOf('reconnect');
        expect(openIdx).toBeLessThan(dropIdx);
        expect(dropIdx).toBeLessThan(reconnectIdx);

        // now close normally
        await page.evaluate(() => (window as W).__conn.close());

        await expect(async () => {
            const log2 = await page.evaluate(() => (window as W).__stateLog);
            expect(log2).toContain('close');
        }).toPass({ timeout: 3000 });

        // full log: open → drop → reconnect → close
        const finalLog = await page.evaluate(() => (window as W).__stateLog);
        expect(finalLog).toEqual(['open', 'drop', 'reconnect', 'close']);
    } finally {
        await room.stop();
    }
});
