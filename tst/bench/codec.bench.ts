import { describe, test } from 'vitest';
import { type NotifyMessage, notifyCodec } from '../../src/common/notify-protocol';
import { packProtocol, unpackFrame } from '../../src/common/protocol';

const session = {
    type: 'session' as const,
    token: 'f3a9c0de51b27e48a6d1903c7be4f825',
    clientId: '0b6f2c9e-4d1a-4f7e-9a3b-6c5d8e1f2a70',
};

const heartbeat: NotifyMessage = {
    type: 'heartbeat',
    timestamp: 1713300000123.456,
    metrics: { memoryRss: 123456789, memoryHeapUsed: 45678901, memoryHeapTotal: 67890123, cpuUser: 1234567, cpuSystem: 234567 },
    clients: Array.from({ length: 50 }, (_, i) => ({
        clientId: `0b6f2c9e-4d1a-4f7e-9a3b-${String(i).padStart(12, '0')}`,
        tags: { team: i % 2 === 0 ? 'red' : 'blue', region: 'us-east', skill: String(i * 7), mode: 'ranked' },
    })),
};

// bound once so the bench does not pay for module export getters on every call
const packSession = packProtocol;
const unpackSession = unpackFrame;
const packHeartbeat = notifyCodec.pack;
const unpackHeartbeat = notifyCodec.unpack;

const sessionFrame = packSession(session);
const heartbeatBytes = packHeartbeat(heartbeat);
console.log(`encoded sizes: session frame ${sessionFrame.byteLength} bytes, heartbeat ${heartbeatBytes.byteLength} bytes`);

describe('protocol codec throughput', () => {
    test('session message', async ({ bench }) => {
        await bench.compare(
            bench('packProtocol', () => {
                packSession(session);
            }),
            bench('unpackFrame', () => {
                unpackSession(sessionFrame);
            }),
        );
    });

    test('heartbeat, 50 clients x 4 tags', async ({ bench }) => {
        await bench.compare(
            bench('notifyCodec.pack', () => {
                packHeartbeat(heartbeat);
            }),
            bench('notifyCodec.unpack', () => {
                unpackHeartbeat(heartbeatBytes);
            }),
        );
    });
});
