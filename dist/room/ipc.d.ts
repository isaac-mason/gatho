import { type Notifier } from '../common/notify-protocol';
/** parsed form of a GATHO_NOTIFY_SOCKET uri */
export type NotifyTarget = {
    kind: 'uds';
    path: string;
} | {
    kind: 'tcp';
    host: string;
    port: number;
    token: string;
};
/** parse a notify target: `uds:<path>`, `tcp://host:port?token=...`, or a bare
 *  filesystem path (treated as a uds socket path). */
export declare function parseNotifyTarget(uri: string): NotifyTarget;
/** dial a parsed notify target */
export declare function connectNotify(target: NotifyTarget, options?: {
    retries?: number;
    retryDelayMs?: number;
    onClose?: () => void;
}): Promise<Notifier>;
