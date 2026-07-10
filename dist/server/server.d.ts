import type { Driver, RoomData } from '../driver/types';
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
    /** port to listen on for server HTTP endpoint (health, ping) and driver communication */
    port?: number;
    /** host to listen on for server HTTP endpoint and driver communication */
    host?: string;
    /**
     * cadence of the heartbeat loop (heartbeat + room reconciliation) in milliseconds.
     * note this does not control the timing of room startup, only teardown.
     * @default 5000
     **/
    heartbeatIntervalMs?: number;
    /** tags for this server instance (defaults to `{}`) */
    tags?: Record<string, string>;
    /** timeout for draining rooms in milliseconds */
    drainTimeoutMs?: number;
    /** full URL for this server's HTTP endpoint, e.g. "http://localhost:3000" or "https://us-east.mysite.com".
     *  if not set, defaults to "http://{host}:{port}" using the bound address. */
    serverEndpoint?: string;
    /** how long a freshly spawned room may take to send its first notify message
     *  before startup is considered failed and the room is killed. raise this when
     *  spawning is slow — e.g. a docker runner whose first spawn pulls the image.
     *  @default 30000 */
    roomStartupTimeoutMs?: number;
    /** how long a started room may go without a heartbeat before it is considered
     *  stalled and killed (rooms heartbeat every ~3s). @default 10000 */
    roomStallTimeoutMs?: number;
};
export type RoomDetails = {
    roomId: string;
    roomType: string;
    workerRunning: boolean;
    endpoint: string | null;
    /** the room's lifecycle as the server observes it */
    status: 'starting' | 'ready' | 'stopped';
    /** wall-clock ms of the room's last heartbeat (or first notify message),
     *  null before the room has spoken */
    lastHeartbeatAt: number | null;
};
export type Server = {
    stop(): Promise<void>;
    address(): {
        host: string;
        port: number;
    } | null;
    readonly serverId: string;
    getRoomDetails(roomId: string): RoomDetails | null;
    getAllRoomDetails(): RoomDetails[];
};
export declare function reconcileClients(driver: Driver['_internal'], roomId: string, roomClients: {
    clientId: string;
    tags: Record<string, string>;
}[], heartbeatTimestamp: number): Promise<void>;
export declare function start(options: CreateServerOptions): Promise<Server>;
export type TestRoom = {
    roomId: string;
    roomType: string;
    roomSecret: string;
    data: RoomData;
    endpoint: string | null;
    status: 'starting' | 'ready' | 'stopped';
};
export declare function __heartbeatTickForTest(args: {
    driver: Driver['_internal'];
    serverId: string;
    endpoint: string;
    rooms: TestRoom[];
    previouslyRegistered: boolean;
}): Promise<{
    killed: string[];
}>;
