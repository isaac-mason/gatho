import { connect, type RoomConnection } from 'gatho/client';
import { useEffect, useRef, useState } from 'react';
import { clientCodec, decodeCoord, encodeCoord, serverCodec } from '../../shared/protocol';
import './styles.css';

// same-origin in production (Caddy proxies /api to the backend); in dev the vite
// proxy forwards /api to localhost:7100. override with VITE_API_URL if needed.
const API_URL = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? '';

// send our cursor at most ~20Hz (the server batches + rebroadcasts at ~15Hz)
const SEND_MS = 50;

// cursors are keyed by the compact `cid` from the wire; x/y are decoded to 0..1.
interface Cursor {
    color: string;
    name: string;
    x: number;
    y: number;
}

type Status = 'connecting' | 'connected' | 'reconnecting' | 'closed';

function CursorView({ x, y, color, name }: { x: number; y: number; color: string; name: string }) {
    return (
        <div className="cursor" style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 2L17 9L10 11L8 17L3 2Z" fill={color} stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span className="cursor-label" style={{ background: color }}>
                {name}
            </span>
        </div>
    );
}

export function App() {
    const [cursors, setCursors] = useState<Record<number, Cursor>>({});
    const [count, setCount] = useState(0);
    const [status, setStatus] = useState<Status>('connecting');
    const [me, setMe] = useState<{ cid: number; color: string; name: string } | null>(null);

    const roomRef = useRef<RoomConnection | null>(null);
    // our own cid, in a ref so the message handler can filter our own echoes.
    const meCidRef = useRef<number | null>(null);

    // --- connect + receive ---
    useEffect(() => {
        let room: RoomConnection | null = null;
        let cancelled = false;

        (async () => {
            const res = await fetch(`${API_URL}/api/join`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
            });
            const seat = (await res.json()) as { url: string };
            if (cancelled) return;

            room = connect(seat.url, {
                onOpen: () => setStatus('connected'),
                onDrop: () => setStatus('reconnecting'),
                onReconnect: () => setStatus('connected'),
                onClose: () => setStatus('closed'),

                onMessage: (msg) => {
                    if (typeof msg === 'string') return; // binary only
                    const data = serverCodec.unpack(new Uint8Array(msg));

                    if (data.type === 'snapshot') {
                        meCidRef.current = data.you;
                        setMe({ cid: data.you, color: data.color, name: data.name });
                        const map: Record<number, Cursor> = {};
                        for (const c of data.cursors) {
                            map[c.cid] = { color: c.color, name: c.name, x: decodeCoord(c.x), y: decodeCoord(c.y) };
                        }
                        setCursors(map);
                    } else if (data.type === 'join') {
                        if (data.cid === meCidRef.current) return;
                        setCursors((prev) => ({
                            ...prev,
                            [data.cid]: { color: data.color, name: data.name, x: decodeCoord(data.x), y: decodeCoord(data.y) },
                        }));
                    } else if (data.type === 'frame') {
                        setCursors((prev) => {
                            const next = { ...prev };
                            for (const mv of data.moves) {
                                if (mv.cid === meCidRef.current) continue;
                                const c = next[mv.cid];
                                if (c) next[mv.cid] = { ...c, x: decodeCoord(mv.x), y: decodeCoord(mv.y) };
                            }
                            return next;
                        });
                    } else if (data.type === 'leave') {
                        setCursors((prev) => {
                            const next = { ...prev };
                            delete next[data.cid];
                            return next;
                        });
                    } else if (data.type === 'presence') {
                        setCount(data.count);
                    }
                },
            });
            roomRef.current = room;
        })();

        return () => {
            cancelled = true;
            room?.close();
        };
    }, []);

    // --- send our cursor, rate-limited to ~20Hz ---
    useEffect(() => {
        let pending: { x: number; y: number } | null = null;

        const onMove = (e: PointerEvent) => {
            pending = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
        };

        const interval = setInterval(() => {
            if (!pending || !roomRef.current) return;
            // unreliable: positions are ephemeral, no point buffering stale ones
            roomRef.current.send(clientCodec.pack({ x: encodeCoord(pending.x), y: encodeCoord(pending.y) }), {
                reliable: false,
            });
            pending = null;
        }, SEND_MS);

        window.addEventListener('pointermove', onMove);
        return () => {
            window.removeEventListener('pointermove', onMove);
            clearInterval(interval);
        };
    }, []);

    const others = Object.entries(cursors).filter(([cid]) => Number(cid) !== me?.cid);

    return (
        <div className="stage">
            <nav className="nav">
                <div className="nav-brand">gatho</div>
                <div className="nav-links">
                    <a href="https://github.com/isaac-mason/gatho" target="_blank" rel="noopener noreferrer">github</a>
                </div>
            </nav>

            <div className="hero">
                <h1 className="hero-title">gatho</h1>
                <p className="hero-subtitle">javascript multiplayer toolkit for building real-time games and applications</p>
            </div>

            <footer className="footer">
                <span className="presence">
                    <span className={`status ${status}`} />
                    {count} {count === 1 ? 'person' : 'people'} here
                </span>
                <div className="footer-links">
                    <a href="https://x.com/isaac_mason_" className="footer-link" target="_blank" rel="noopener noreferrer">
                        x.com/isaac_mason_
                    </a>
                    <a href="https://github.com/sponsors/isaac-mason" className="footer-link" target="_blank" rel="noopener noreferrer">
                        sponsor me!
                    </a>
                </div>
            </footer>

            {others.map(([cid, c]) => (
                <CursorView key={cid} x={c.x} y={c.y} color={c.color} name={c.name} />
            ))}
        </div>
    );
}
