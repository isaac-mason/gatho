import { type RoomMessage, type UdsConnection } from '../../common/uds';
export declare function listenOnSocket(socketPath: string, onMessage: (msg: RoomMessage) => void, options?: {
    timeoutMs?: number;
    onClose?: () => void;
}): Promise<UdsConnection>;
export type UdsServer = {
    close: () => void;
};
export declare function createUdsServer(socketPath: string, onMessage: (msg: RoomMessage) => void, options?: {
    timeoutMs?: number;
    onClose?: () => void;
}): Promise<UdsServer>;
