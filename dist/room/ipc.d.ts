import { type UdsConnection } from 'gatho/common';
export declare function connectToSocket(socketPath: string, options?: {
    retries?: number;
    retryDelayMs?: number;
    onClose?: () => void;
}): Promise<UdsConnection>;
