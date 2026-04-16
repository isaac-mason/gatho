import { connect, type RoomConnection } from 'gatho/client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createRoom, fetchRooms, joinRoom, type RoomListItem } from './api';
import './styles.css';

interface ChatMessage {
    type: 'join' | 'leave' | 'message';
    user: string;
    text?: string;
    timestamp: number;
}

// --- lobby ---

function Lobby({
    username,
    onJoined,
}: {
    username: string;
    onJoined: (roomId: string, roomName: string, room: RoomConnection) => void;
}) {
    const [rooms, setRooms] = useState<RoomListItem[]>([]);
    const [newRoomName, setNewRoomName] = useState('');
    const [joining, setJoining] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadRooms = useCallback(async () => {
        const data = await fetchRooms();
        setRooms(data);
    }, []);

    // poll room list
    useEffect(() => {
        loadRooms();
        const interval = setInterval(loadRooms, 2_000);
        return () => clearInterval(interval);
    }, [loadRooms]);

    const handleCreate = async () => {
        if (!newRoomName.trim() || creating) return;
        setCreating(true);
        setError(null);

        try {
            const result = await createRoom(newRoomName.trim(), username);
            setNewRoomName('');

            // connect immediately — creator joins their own room
            const room = connect(result.seat.url);
            onJoined(result.roomId, result.name, room);
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
            const seat = await joinRoom(roomId, username);
            const room = connect(seat.url);
            const name = rooms.find((r) => r.roomId === roomId)?.name ?? roomId;
            onJoined(roomId, name, room);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to join');
            setJoining(null);
        }
    };

    return (
        <div className="lobby">
            <div className="lobby-header">
                <span className="lobby-user">
                    logged in as <strong>{username}</strong>
                </span>
            </div>

            <div className="create-room">
                <input
                    type="text"
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                    placeholder="room name"
                    disabled={creating}
                />
                <button type="button" onClick={handleCreate} disabled={creating || !newRoomName.trim()}>
                    {creating ? 'creating...' : 'create room'}
                </button>
            </div>

            {error && <div className="error">{error}</div>}

            <div className="room-list">
                {rooms.length === 0 && <div className="empty">no rooms yet — create one</div>}
                {rooms.map((r) => (
                    <div key={r.roomId} className="room-item">
                        <div className="room-info">
                            <span className="room-name">{r.name}</span>
                            <span className="room-count">
                                {r.clientCount} {r.clientCount === 1 ? 'user' : 'users'}
                            </span>
                        </div>
                        <button type="button" onClick={() => handleJoin(r.roomId)} disabled={joining === r.roomId}>
                            {joining === r.roomId ? 'joining...' : 'join'}
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}

// --- chat ---

function Chat({ roomName, room, onLeave }: { roomName: string; room: RoomConnection; onLeave: () => void }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [connected, setConnected] = useState(true);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onMessage = (msg: string | ArrayBuffer) => {
            if (typeof msg !== 'string') return;
            setMessages((prev) => [...prev, JSON.parse(msg) as ChatMessage]);
            requestAnimationFrame(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            });
        };

        const onClose = (code: number, reason: string) => {
            setConnected(false);
            setMessages((prev) => [
                ...prev,
                { type: 'leave', user: 'system', text: `disconnected: ${reason || code}`, timestamp: Date.now() },
            ]);
        };

        const onError = () => {
            setConnected(false);
        };

        room.on('message', onMessage);
        room.on('close', onClose);
        room.on('error', onError);

        return () => {
            room.off('message', onMessage);
            room.off('close', onClose);
            room.off('error', onError);
        };
    }, [room]);

    const send = () => {
        const text = input.trim();
        if (!text || !connected) return;
        room.send(JSON.stringify({ text }));
        setInput('');
    };

    const leave = () => {
        room.close();
        onLeave();
    };

    return (
        <div className="chat">
            <div className="chat-header">
                <span className="chat-room-name">{roomName}</span>
                <span className={`chat-status ${connected ? 'connected' : 'disconnected'}`}>
                    {connected ? 'connected' : 'disconnected'}
                </span>
                <button type="button" className="leave-btn" onClick={leave}>
                    leave
                </button>
            </div>

            <div className="messages">
                {messages.map((m, i) => (
                    <div key={`${m.timestamp}-${i}`} className={`msg ${m.type === 'message' ? '' : 'system'}`}>
                        {m.type === 'message' ? (
                            <>
                                <span className="msg-user">{m.user}</span> {m.text}
                            </>
                        ) : m.type === 'join' ? (
                            <>{m.user} joined</>
                        ) : (
                            <>
                                {m.user} left{m.text ? ` (${m.text})` : ''}
                            </>
                        )}
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>

            <div className="input-bar">
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && send()}
                    placeholder="type a message..."
                    disabled={!connected}
                />
                <button type="button" onClick={send} disabled={!connected || !input.trim()}>
                    send
                </button>
            </div>
        </div>
    );
}

// --- app ---

type View =
    | { kind: 'login' }
    | { kind: 'lobby'; username: string }
    | { kind: 'chat'; username: string; roomId: string; roomName: string; room: RoomConnection };

export function App() {
    const [view, setView] = useState<View>({ kind: 'login' });
    const [usernameInput, setUsernameInput] = useState('');
    const usernameId = useId();

    const handleLogin = () => {
        const name = usernameInput.trim() || 'anon';
        setView({ kind: 'lobby', username: name });
    };

    if (view.kind === 'login') {
        return (
            <div className="container">
                <header>
                    <h1>
                        gatho <span>chat</span>
                    </h1>
                </header>
                <div className="login">
                    <label htmlFor={usernameId}>pick a name</label>
                    <input
                        id={usernameId}
                        type="text"
                        value={usernameInput}
                        onChange={(e) => setUsernameInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                        placeholder="alice"
                    />
                    <button type="button" onClick={handleLogin}>
                        go
                    </button>
                </div>
            </div>
        );
    }

    if (view.kind === 'lobby') {
        return (
            <div className="container">
                <header>
                    <h1>
                        gatho <span>chat</span>
                    </h1>
                </header>
                <Lobby
                    username={view.username}
                    onJoined={(roomId, roomName, room) =>
                        setView({ kind: 'chat', username: view.username, roomId, roomName, room })
                    }
                />
            </div>
        );
    }

    return (
        <div className="container">
            <header>
                <h1>
                    gatho <span>chat</span>
                </h1>
            </header>
            <Chat roomName={view.roomName} room={view.room} onLeave={() => setView({ kind: 'lobby', username: view.username })} />
        </div>
    );
}
