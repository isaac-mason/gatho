// ha example frontend — demonstrates multi-server deployment
// lobby (server list + room list) → ping room

import { connect, type ConnectHandlers, type RoomConnection } from 'gatho/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoom, fetchRooms, fetchServers, joinRoom, type RoomListItem, type ServerListItem } from './api';
import './styles.css';

// --- types ---

interface PongMessage {
    type: 'pong';
    server: string;
    pingCount: number;
    ts: number;
}

interface JoinMessage {
    type: 'join';
    user: string;
    ts: number;
}

interface LeaveMessage {
    type: 'leave';
    user: string;
    ts: number;
}

type RoomMessage = PongMessage | JoinMessage | LeaveMessage;

// the connection opens in the lobby but the ui that reacts to events lives in
// <PingRoom>, which mounts later. bridge them with a mutable handler bag: the
// single-handler client forwards each event to whatever the bag points at, and
// <PingRoom> installs its handlers on mount.
type LiveConnection = {
    conn: RoomConnection;
    handlers: ConnectHandlers;
};

function openConnection(url: string): LiveConnection {
    const handlers: ConnectHandlers = {};
    const conn = connect(url, {
        onMessage: (msg) => handlers.onMessage?.(msg),
        onClose: (info) => handlers.onClose?.(info),
        onError: (e) => handlers.onError?.(e),
    });
    return { conn, handlers };
}

// --- server list ---

function ServerList({ servers }: { servers: ServerListItem[] }) {
    if (servers.length === 0) {
        return <div className="empty">no servers online</div>;
    }

    return (
        <div className="server-list">
            <div className="section-label">servers</div>
            {servers.map((s) => (
                <div key={s.serverId} className="server-item">
                    <div className="server-info">
                        <span className="server-id">{s.serverId.slice(0, 12)}</span>
                        <span className="server-endpoint">{s.endpoint}</span>
                    </div>
                    <span className="server-rooms">
                        {s.rooms.length} {s.rooms.length === 1 ? 'room' : 'rooms'}
                    </span>
                </div>
            ))}
        </div>
    );
}

// --- lobby ---

function Lobby({ onJoined }: { onJoined: (roomId: string, live: LiveConnection) => void }) {
    const [rooms, setRooms] = useState<RoomListItem[]>([]);
    const [servers, setServers] = useState<ServerListItem[]>([]);
    const [joining, setJoining] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        const [roomData, serverData] = await Promise.all([fetchRooms(), fetchServers()]);
        setRooms(roomData);
        setServers(serverData);
    }, []);

    // poll room + server list
    useEffect(() => {
        loadData();
        const interval = setInterval(loadData, 2_000);
        return () => clearInterval(interval);
    }, [loadData]);

    const handleCreate = async () => {
        if (creating) return;
        setCreating(true);
        setError(null);

        try {
            const result = await createRoom();
            const live = openConnection(result.seat.url);
            onJoined(result.roomId, live);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to create room');
            setCreating(false);
        }
    };

    const handleJoin = async (roomId: string) => {
        if (joining) return;
        setJoining(roomId);
        setError(null);

        try {
            const seat = await joinRoom(roomId);
            const live = openConnection(seat.url);
            onJoined(roomId, live);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to join');
            setJoining(null);
        }
    };

    return (
        <div className="lobby">
            <div className="lobby-header">
                <button type="button" onClick={handleCreate} disabled={creating || servers.length === 0}>
                    {creating ? 'creating...' : 'create ping room'}
                </button>
            </div>

            {error && <div className="error">{error}</div>}

            <ServerList servers={servers} />

            <div className="room-list">
                <div className="section-label">rooms</div>
                {rooms.length === 0 && <div className="empty">no rooms yet — create one</div>}
                {rooms.map((r) => {
                    const connected = r.clients.filter((c) => c.status === 'connected').length;
                    return (
                        <div key={r.roomId} className="room-item">
                            <div className="room-info">
                                <span className="room-name">{r.roomId.slice(0, 12)}</span>
                                <span className="room-meta">
                                    server {r.serverId.slice(0, 8)} · {connected} {connected === 1 ? 'user' : 'users'}
                                </span>
                            </div>
                            <button type="button" onClick={() => handleJoin(r.roomId)} disabled={joining === r.roomId}>
                                {joining === r.roomId ? 'joining...' : 'join'}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// --- ping room ---

function PingRoom({ roomId, live, onLeave }: { roomId: string; live: LiveConnection; onLeave: () => void }) {
    const [messages, setMessages] = useState<RoomMessage[]>([]);
    const [connected, setConnected] = useState(true);
    const [pingSent, setPingSent] = useState(0);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // point the connection's handler bag at this component's state setters.
        live.handlers.onMessage = (msg) => {
            if (typeof msg !== 'string') return;
            setMessages((prev) => [...prev, JSON.parse(msg) as RoomMessage]);
            requestAnimationFrame(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            });
        };

        live.handlers.onClose = () => {
            setConnected(false);
            setMessages((prev) => [...prev, { type: 'leave', user: 'system', ts: Date.now() }]);
        };

        live.handlers.onError = () => {
            setConnected(false);
        };

        return () => {
            live.handlers.onMessage = undefined;
            live.handlers.onClose = undefined;
            live.handlers.onError = undefined;
        };
    }, [live]);

    const sendPing = () => {
        if (!connected) return;
        live.conn.send(JSON.stringify({ type: 'ping' }));
        setPingSent((n) => n + 1);
    };

    const leave = () => {
        live.conn.close();
        onLeave();
    };

    return (
        <div className="ping-room">
            <div className="ping-header">
                <span className="ping-room-name">{roomId.slice(0, 12)}</span>
                <span className={`ping-status ${connected ? 'connected' : 'disconnected'}`}>
                    {connected ? 'connected' : 'disconnected'}
                </span>
                <button type="button" className="leave-btn" onClick={leave}>
                    leave
                </button>
            </div>

            <div className="ping-controls">
                <button type="button" onClick={sendPing} disabled={!connected}>
                    ping
                </button>
                <span className="ping-count">sent: {pingSent}</span>
            </div>

            <div className="messages">
                {messages.map((m, i) => {
                    if (m.type === 'pong') {
                        const latency = Date.now() - m.ts;
                        return (
                            <div key={`${m.ts}-${i}`} className="msg pong">
                                <span className="pong-label">pong</span>
                                <span className="pong-server">server: {m.server}</span>
                                <span className="pong-count">#{m.pingCount}</span>
                                <span className="pong-latency">{latency}ms</span>
                            </div>
                        );
                    }

                    if (m.type === 'join') {
                        return (
                            <div key={`${m.ts}-${i}`} className="msg system">
                                {m.user} joined
                            </div>
                        );
                    }

                    return (
                        <div key={`${m.ts}-${i}`} className="msg system">
                            {m.user} left
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>
        </div>
    );
}

// --- app ---

type View = { kind: 'lobby' } | { kind: 'ping'; roomId: string; live: LiveConnection };

export function App() {
    const [view, setView] = useState<View>({ kind: 'lobby' });

    if (view.kind === 'lobby') {
        return (
            <div className="container">
                <header>
                    <h1>
                        gatho <span>ha</span>
                    </h1>
                    <p className="subtitle">multi-server ping demo</p>
                </header>
                <Lobby onJoined={(roomId, live) => setView({ kind: 'ping', roomId, live })} />
            </div>
        );
    }

    return (
        <div className="container">
            <header>
                <h1>
                    gatho <span>ha</span>
                </h1>
            </header>
            <PingRoom roomId={view.roomId} live={view.live} onLeave={() => setView({ kind: 'lobby' })} />
        </div>
    );
}
