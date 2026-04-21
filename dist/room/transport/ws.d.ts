import type { Transport } from './types';
export type WsTransportConfig = {
    maxPayload?: number;
    perMessageDeflate?: boolean;
};
export declare function wsTransport(config?: WsTransportConfig): Transport;
