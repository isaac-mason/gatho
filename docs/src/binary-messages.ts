// shared/protocol.ts
//
// the recommended shape: define ONE ClientPacket union (client → server) and ONE
// ServerPacket union (server → client), share this module between client and
// server, and get compact binary encoding with full TypeScript types. adding a
// message means adding a variant here, and both ends update in lockstep — the
// compiler tells you what you missed. no code generation, no IDL files.

import * as p from 'packcat';

// --- client → server messages ---

const Input = p.object({
    type: p.literal('input'),
    movement: p.list(p.float32(), 2), // [x, y]
});

const Chat = p.object({
    type: p.literal('chat'),
    text: p.string(),
});

// --- server → client messages ---

const Snapshot = p.object({
    type: p.literal('snapshot'),
    tick: p.varuint(),
    players: p.list(
        p.object({
            id: p.varuint(),
            position: p.list(p.float32(), 2), // [x, y]
        }),
    ),
});

const ChatBroadcast = p.object({
    type: p.literal('chat'),
    from: p.varuint(),
    text: p.string(),
});

// one union per direction — the whole protocol surface, discriminated on `type`.
const ClientPacket = p.union('type', [Input, Chat]);
const ServerPacket = p.union('type', [Snapshot, ChatBroadcast]);

export type ClientPacket = p.SchemaType<typeof ClientPacket>;
export type ServerPacket = p.SchemaType<typeof ServerPacket>;

// build the (de)serializers once and reuse them.
export const clientCodec = p.build(ClientPacket);
export const serverCodec = p.build(ServerPacket);

// --- client side ---

// send a typed input, receive a typed snapshot. gatho carries the bytes; packcat
// gives you exhaustive `switch (packet.type)` on both ends.
const inputBytes: Uint8Array<ArrayBufferLike> = clientCodec.pack({ type: 'input', movement: [1, 0] });
console.log('packed client packet:', inputBytes);

function onServerMessage(bytes: ArrayBuffer) {
    const packet: ServerPacket = serverCodec.unpack(new Uint8Array(bytes));
    switch (packet.type) {
        case 'snapshot':
            console.log('tick', packet.tick, 'players', packet.players);
            break;
        case 'chat':
            console.log(`${packet.from}: ${packet.text}`);
            break;
    }
}

// --- server side ---

const snapshotBytes: Uint8Array<ArrayBufferLike> = serverCodec.pack({
    type: 'snapshot',
    tick: 123,
    players: [{ id: 1, position: [10, 20] }],
});
console.log('packed server packet:', snapshotBytes);

function onClientMessage(bytes: ArrayBuffer) {
    const packet: ClientPacket = clientCodec.unpack(new Uint8Array(bytes));
    switch (packet.type) {
        case 'input':
            console.log('movement', packet.movement);
            break;
        case 'chat':
            console.log('chat', packet.text);
            break;
    }
}

// keep the example's helpers referenced so tsc doesn't flag them as unused.
onServerMessage(snapshotBytes.buffer as ArrayBuffer);
onClientMessage(inputBytes.buffer as ArrayBuffer);
