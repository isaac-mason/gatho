import type { RoomInfo } from './types';
export type RoomSignalHandlers = {
    ready: () => void;
    failed: (reason: string) => void;
};
/** shared waitForRoom for every driver: signals make it fast, the record poll guarantees it settles. */
export declare function waitForRoomRunning(roomId: string, timeoutMs: number, registered: Promise<void>, getRoomInfo: (roomId: string) => Promise<RoomInfo | null>, subscribeSignals: (handlers: RoomSignalHandlers) => Promise<() => void>): Promise<RoomInfo>;
