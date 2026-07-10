// --- close codes ---

// websocket close codes that gatho uses to distinguish disconnect reasons.
// lives in common/ so both the client and the room can share the constant
// without the client importing gatho/room. gatho/room re-exports it unchanged.
// 4000 (CONSENTED) = the client explicitly called close() — sent __leave first.
// everything else fires onDrop, giving the room code a chance to call allowReconnection.
export const CloseCode = {
    NORMAL: 1000,
    GOING_AWAY: 1001,
    ABNORMAL: 1006,
    CONSENTED: 4000,
} as const;
