// api client for the example server

const API_URL = 'http://localhost:3100';

export interface RoomListItem {
    roomId: string;
    roomType: string;
    name: string;
    clientCount: number;
    createdAt: number;
}

export interface SeatInfo {
    url: string;
    roomId: string;
}

export async function fetchRooms(): Promise<RoomListItem[]> {
    const res = await fetch(`${API_URL}/api/rooms`);
    if (!res.ok) throw new Error('failed to fetch rooms');
    return res.json();
}

export interface CreateRoomResult {
    roomId: string;
    name: string;
    seat: SeatInfo;
}

export async function createRoom(name: string, displayName?: string): Promise<CreateRoomResult> {
    const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, displayName }),
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'failed to create room');
    }
    return res.json();
}

export async function joinRoom(roomId: string, displayName?: string): Promise<SeatInfo> {
    const res = await fetch(`${API_URL}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId, displayName }),
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'failed to join room');
    }
    return res.json();
}
