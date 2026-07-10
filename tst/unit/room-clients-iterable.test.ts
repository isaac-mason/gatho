import { beforeEach, describe, expect, it } from 'vitest';
import { unpackFrame } from '../../src/common/protocol';
import { auth, start } from '../../src/room/index';
import type {
    ClientSocket,
    Transport,
    TransportHandlers,
    TransportListenConfig,
    TransportServer,
} from '../../src/room/transport/types';

// minimal stub transport — we only drive open() and iterate the collection.
type Captured = { handlers: TransportHandlers; subscribers: Set<unknown> };

function stubTransport(sink: { captured?: Captured }): Transport {
    const subscribers = new Set<unknown>();
    return {
        listen(handlers: TransportHandlers, _config?: TransportListenConfig): Promise<TransportServer> {
            const server: TransportServer = {
                port: 0,
                publish() {},
                close() {},
            };
            sink.captured = { handlers, subscribers };
            return Promise.resolve(server);
        },
    };
}

function socket(): ClientSocket {
    return {
        send(data) {
            if (typeof data !== 'string') unpackFrame(data);
        },
        close() {},
        subscribe() {},
        bufferedAmount() {
            return 0;
        },
    };
}

async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
}

describe('room.clients iterable', () => {
    let sink: { captured?: Captured };

    function handlers(): TransportHandlers {
        if (!sink.captured) throw new Error('transport never captured handlers');
        return sink.captured.handlers;
    }

    beforeEach(() => {
        sink = {};
    });

    it('yields a handle per client via for..of', async () => {
        const room = await start({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: (_r, joinData: { name: string }) => auth.ok({ name: joinData.name }),
        });

        handlers().open('a', socket(), { name: 'alice' }, {});
        handlers().open('b', socket(), { name: 'bob' }, {});
        await settle();

        const ids: string[] = [];
        const names: string[] = [];
        for (const client of room.clients) {
            ids.push(client.id);
            names.push((client.data as { name: string }).name);
        }

        expect(ids.sort()).toEqual(['a', 'b']);
        expect(names.sort()).toEqual(['alice', 'bob']);
    });

    it('supports spread and Array.from without allocating via all()', async () => {
        const room = await start({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => auth.ok({}),
        });

        handlers().open('a', socket(), {}, {});
        handlers().open('b', socket(), {}, {});
        handlers().open('c', socket(), {}, {});
        await settle();

        expect([...room.clients].length).toBe(3);
        expect(Array.from(room.clients).map((c) => c.id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('yields nothing for an empty room', async () => {
        const room = await start({
            standalone: true,
            transport: stubTransport(sink),
            onAuth: () => auth.ok({}),
        });

        expect([...room.clients]).toEqual([]);
    });
});
