// binary wire format for the cursor demo, shared by the room isolate + frontend.
// (same design as website/shared/protocol.ts — see that file for the rationale.)
//
// each client gets a compact 2-byte `cid`. identity (color + name) is sent ONCE
// when a cursor first appears (join / snapshot); per-tick movement frames carry
// only `cid` + quantized x/y.
//
// note for the workerd side: packcat's `pack.build()` generates codec functions
// with `new Function(...)` at module init — this only loads in a room isolate
// because the harness sets the `allow_eval_during_startup` compat flag.

import * as pack from 'packcat';

// cursor coords are normalized 0..1, quantized to a uint16.
export const COORD_MAX = 65535;
export const encodeCoord = (n: number): number => {
    const v = Math.round(n * COORD_MAX);
    return v < 0 ? 0 : v > COORD_MAX ? COORD_MAX : v;
};
export const decodeCoord = (n: number): number => n / COORD_MAX;

// --- server -> client ---

const Cursor = pack.object({
    cid: pack.uint16(),
    color: pack.string(),
    name: pack.string(),
    x: pack.uint16(),
    y: pack.uint16(),
});

const Snapshot = pack.object({
    type: pack.literal('snapshot'),
    you: pack.uint16(),
    color: pack.string(),
    name: pack.string(),
    cursors: pack.list(Cursor),
});

const Join = pack.object({
    type: pack.literal('join'),
    cid: pack.uint16(),
    color: pack.string(),
    name: pack.string(),
    x: pack.uint16(),
    y: pack.uint16(),
});

const Move = pack.object({
    cid: pack.uint16(),
    x: pack.uint16(),
    y: pack.uint16(),
});
const Frame = pack.object({
    type: pack.literal('frame'),
    moves: pack.list(Move),
});

const Leave = pack.object({
    type: pack.literal('leave'),
    cid: pack.uint16(),
});

const Presence = pack.object({
    type: pack.literal('presence'),
    count: pack.uint16(),
});

const ServerMessage = pack.union('type', [Snapshot, Join, Frame, Leave, Presence]);
export const serverCodec = pack.build(ServerMessage);
export type ServerMessage = pack.SchemaType<typeof ServerMessage>;

// --- client -> server ---

const ClientMove = pack.object({
    x: pack.uint16(),
    y: pack.uint16(),
});
export const clientCodec = pack.build(ClientMove);
export type ClientMove = pack.SchemaType<typeof ClientMove>;
