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
    /** directory for the per-room UDS sockets used for server↔room IPC. defaults to
     *  `${os.tmpdir()}/gatho-ipc`. set an explicit path when running rooms in docker
     *  (or any other sandbox) so the same path can be bind-mounted into the container
     *  and appear in `GATHO_SOCKET` unchanged. created if it doesn't exist. */
    socketDir?: string;
};
export type RoomDetails = {
    roomId: string;
    roomType: string;
    workerRunning: boolean;
    endpoint: string | null;
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
/**
 * Build the per-room UDS socket path: `socketDir/<roomId>/sock`.
 *
 * The per-room subdirectory (rather than a flat `socketDir/<roomId>.sock`) is what
 * lets a container runner mount each room only its own socket dir, isolating the
 * IPC channel from sibling rooms. `roomId` becomes a path segment, so reject
 * anything that could escape `socketDir`.
 *
 * The socket filename is kept to `sock` (not e.g. `room.sock`) on purpose: unix
 * socket paths have a hard length limit (~104 bytes on macOS) and the per-room
 * subdir already costs the `roomId` segment. `<roomId>/sock` is the same length as
 * the old flat `<roomId>.sock`, so we don't regress paths that used to fit. Don't
 * lengthen this filename without re-checking that limit on the longest socketDir.
 */
export declare function roomSocketPath(socketDir: string, roomId: string): string;
export declare function start(options: CreateServerOptions): Promise<Server>;
