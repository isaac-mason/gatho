// api client for ha example backend

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export type ClientInfo = {
    clientId: string;
    status: 'reserved' | 'connected';
};

export type RoomListItem = {
    roomId: string;
    roomType: string;
    serverId: string;
    clients: ClientInfo[];
    data: Record<string, string | number | boolean>;
    tags: Record<string, string>;
    createdAt: number;
};

export type ServerListItem = {
    serverId: string;
    endpoint: string;
    lastHeartbeat: number;
    rooms: RoomListItem[];
    tags: Record<string, string>;
    roomTypes: string[];
};

export type SeatInfo = {
    url: string;
    roomId: string;
};

export type CreateRoomResult = {
    roomId: string;
    serverId: string;
    seat: SeatInfo;
};

export async function fetchRooms(): Promise<RoomListItem[]> {
    const res = await fetch(`${API_URL}/api/rooms`);
    if (!res.ok) throw new Error('failed to fetch rooms');
    return res.json();
}

export async function fetchServers(): Promise<ServerListItem[]> {
    const res = await fetch(`${API_URL}/api/servers`);
    if (!res.ok) throw new Error('failed to fetch servers');
    return res.json();
}

export async function createRoom(): Promise<CreateRoomResult> {
    const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'failed to create room');
    }
    return res.json();
}

export async function joinRoom(roomId: string): Promise<SeatInfo> {
    const res = await fetch(`${API_URL}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId }),
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'failed to join room');
    }
    return res.json();
}
