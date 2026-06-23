// binary wire format for the cursor demo, shared by the backend + frontend.
//
// design: each client gets a compact 2-byte `cid`. identity (color + name) is
// sent ONCE when a cursor first appears (join / snapshot); the per-tick movement
// frames carry only `cid` + quantized x/y, so a moving cursor costs 6 bytes/tick
// instead of a fat json blob every frame.

import * as pack from 'packcat';

// cursor coords are normalized 0..1, quantized to a uint16 (1/65535 ≈ 0.0015%
// precision — far finer than a pixel). encode before sending, decode to render.
export const COORD_MAX = 65535;
export const encodeCoord = (n: number): number => {
    const v = Math.round(n * COORD_MAX);
    return v < 0 ? 0 : v > COORD_MAX ? COORD_MAX : v;
};
export const decodeCoord = (n: number): number => n / COORD_MAX;

// --- server -> client ---

// a full cursor (identity + position) — used in snapshots.
const Cursor = pack.object({
    cid: pack.uint16(),
    color: pack.string(),
    name: pack.string(),
    x: pack.uint16(),
    y: pack.uint16(),
});

// sent to a newcomer: their own cid + identity, plus everyone already present.
const Snapshot = pack.object({
    type: pack.literal('snapshot'),
    you: pack.uint16(),
    color: pack.string(),
    name: pack.string(),
    cursors: pack.list(Cursor),
});

// a cursor appeared for the first time (identity learned here, once).
const Join = pack.object({
    type: pack.literal('join'),
    cid: pack.uint16(),
    color: pack.string(),
    name: pack.string(),
    x: pack.uint16(),
    y: pack.uint16(),
});

// per-tick batch of movements — only cursors that moved this tick, cid + pos.
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

// the only thing a client sends: its latest cursor position (quantized).
const ClientMove = pack.object({
    x: pack.uint16(),
    y: pack.uint16(),
});
export const clientCodec = pack.build(ClientMove);
export type ClientMove = pack.SchemaType<typeof ClientMove>;
