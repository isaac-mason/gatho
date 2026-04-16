import type { Driver } from '../driver/types';
import type { RoomRunner } from './runner/types';
export type RoomEndpointFn = (info: {
    roomId: string;
    port: number;
}) => string;
export type CreateServerOptions = {
    /** map of supported room types to their corresponding RoomRunner */
    rooms: Record<string, RoomRunner>;
    /** driver instance for multi-server communication */
    driver: Driver;
    /** returns the full ws:// or wss:// URL clients will connect to for a room */
    roomEndpoint: RoomEndpointFn;
    /** port to listen on for admin HTTP endpoint (health, ping) and driver communication */
    port?: number;
    /** host to listen on for admin HTTP endpoint and driver communication */
    host?: string;
    /** interval for reconciliation loop in milliseconds */
    reconcileIntervalMs?: number;
    /** tags for this server instance */
    tags: Record<string, string>;
    /** timeout for draining rooms in milliseconds */
    drainTimeoutMs?: number;
    /** full URL for this server's admin HTTP endpoint, e.g. "http://localhost:3000" or "https://us-east.mysite.com".
     *  if not set, defaults to "http://{host}:{port}" using the bound address. */
    serverEndpoint?: string;
};
export type RoomDetails = {
    roomId: string;
    roomType: string;
    workerRunning: boolean;
    endpoint: string | null;
};
export type Server = {
    start(): Promise<void>;
    stop(): Promise<void>;
    address(): {
        host: string;
        port: number;
    } | null;
    readonly serverId: string;
    getRoomDetails(roomId: string): RoomDetails | null;
    getAllRoomDetails(): RoomDetails[];
};
export declare function createServer(options: CreateServerOptions): Server;
