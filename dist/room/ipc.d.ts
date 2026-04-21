import { type UdsConnection } from '../common/uds';
export declare function connectToSocket(socketPath: string, options?: {
    retries?: number;
    retryDelayMs?: number;
    onClose?: () => void;
}): Promise<UdsConnection>;
