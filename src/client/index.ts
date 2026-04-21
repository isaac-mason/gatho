import { frameUserMessage, packProtocol, unpackFrame } from 'gatho/common';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type SendOptions = { reliable?: boolean };

// outbound message — mirrors WebSocket.send() accepted types
export type SendMessage = string | ArrayBuffer | ArrayBufferView | Blob;

// inbound message — mirrors MessageEvent.data with binaryType 'arraybuffer'
export type ReceiveMessage = string | ArrayBuffer;

type BufferedMessage = {
    payload: SendMessage;
    byteSize: number;
};

export type RoomConnection = {
    // current connection state
    readonly state: ConnectionState;

    // send a message to the server.
    // if message is Uint8Array or ArrayBuffer, sends as binary, otherwise JSON-serialized.
    // reliable (default true): buffers during RECONNECTING and flushes on reconnect.
    // unreliable: drops if not OPEN.
    send(message: SendMessage, options?: SendOptions): void;

    // register a listener for an event. returns an unsubscribe function.
    // multiple listeners can be registered for the same event.
    on(event: 'open', callback: () => void): () => void;
    on(event: 'message', callback: (message: ReceiveMessage) => void): () => void;
    on(event: 'drop', callback: () => void): () => void;
    on(event: 'reconnect', callback: () => void): () => void;
    on(event: 'authError', callback: (error: unknown) => void): () => void;
    on(event: 'close', callback: (code: number, reason: string) => void): () => void;
    on(event: 'error', callback: (error: Event) => void): () => void;

    // remove a previously registered listener by reference
    off(event: 'open', callback: () => void): void;
    off(event: 'message', callback: (message: ReceiveMessage) => void): void;
    off(event: 'drop', callback: () => void): void;
    off(event: 'reconnect', callback: () => void): void;
    off(event: 'authError', callback: (error: unknown) => void): void;
    off(event: 'close', callback: (code: number, reason: string) => void): void;
    off(event: 'error', callback: (error: Event) => void): void;

    // close the connection. sends __leave protocol message before closing
    // with code 4000 (consented), telling the server this is intentional.
    // if RECONNECTING, stops the backoff loop and enters CLOSED.
    close(): void;
};

type ListenerMap = {
    open: Set<() => void>;
    message: Set<(message: ReceiveMessage) => void>;
    drop: Set<() => void>;
    reconnect: Set<() => void>;
    authError: Set<(error: unknown) => void>;
    close: Set<(code: number, reason: string) => void>;
    error: Set<(error: Event) => void>;
};

// backoff constants — hardcoded, always right
const MIN_DELAY = 1000;
const MAX_DELAY = 10000;
const BACKOFF_FACTOR = 1.5;
const MIN_UPTIME = 5000;

// outbound reliable message buffer cap — 1mb
const MAX_BUFFER_BYTES = 1_048_576;

// compute backoff delay with jitter
function computeDelay(retryCount: number): number {
    const base = MIN_DELAY * BACKOFF_FACTOR ** (retryCount - 1);
    // jitter ±50%
    const jittered = base * (0.5 + Math.random());
    return Math.min(jittered, MAX_DELAY);
}

// build the reconnect url by appending ?session=<token> or &session=<token>
function buildReconnectUrl(originalUrl: string, sessionToken: string): string {
    const separator = originalUrl.includes('?') ? '&' : '?';
    return `${originalUrl}${separator}session=${sessionToken}`;
}

// connect to a gatho room. url is the full websocket url with token
// baked in as a query param, e.g. "ws://localhost:9001?token=..."
// returned by sdk.join().url
export function connect(url: string): RoomConnection {
    // --- mutable state ---
    let state: ConnectionState = 'connecting';
    let ws: WebSocket | null = null;
    let sessionToken: string | null = null;
    let retryCount = 0;
    let uptimeTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;
    // track the open timestamp so minUptime is checked on drop
    let openedAt: number | null = null;

    // outbound reliable message buffer — messages queued during RECONNECTING
    const reliableBuffer: BufferedMessage[] = [];
    let reliableBufferBytes = 0;

    const listeners: ListenerMap = {
        open: new Set(),
        message: new Set(),
        drop: new Set(),
        reconnect: new Set(),
        authError: new Set(),
        close: new Set(),
        error: new Set(),
    };

    // --- helpers ---

    // estimate byte size of a message for buffer accounting
    function estimateByteSize(message: SendMessage): number {
        if (typeof message === 'string') return message.length * 2;
        if (message instanceof Blob) return message.size;
        if (message instanceof ArrayBuffer) return message.byteLength;
        // ArrayBufferView (Uint8Array, Float32Array, etc.)
        return message.byteLength;
    }

    // buffer a reliable message. if the buffer overflows, transition to CLOSED.
    function bufferReliable(message: SendMessage): void {
        const byteSize = estimateByteSize(message);
        reliableBuffer.push({ payload: message, byteSize });
        reliableBufferBytes += byteSize;
        if (reliableBufferBytes > MAX_BUFFER_BYTES) {
            enterClosed(1009, 'outbound buffer overflow');
        }
    }

    // flush the reliable buffer over the current websocket, then clear it
    function flushReliableBuffer(socket: WebSocket): void {
        for (const buffered of reliableBuffer) {
            socket.send(frameUserMessage(buffered.payload));
        }
        reliableBuffer.length = 0;
        reliableBufferBytes = 0;
    }

    function emit<K extends keyof ListenerMap>(
        event: K,
        ...args: Parameters<
            ListenerMap[K] extends Set<infer F> ? (F extends (...a: infer A) => void ? (...a: A) => void : never) : never
        >
    ): void {
        const set = listeners[event] as Set<(...a: unknown[]) => void>;
        for (const cb of set) cb(...args);
    }

    function clearTimers(): void {
        if (uptimeTimer) {
            clearTimeout(uptimeTimer);
            uptimeTimer = null;
        }
        if (backoffTimer) {
            clearTimeout(backoffTimer);
            backoffTimer = null;
        }
    }

    // send leave protocol message before closing with code 4000 (consented).
    // this tells the server this is an intentional departure, not a network drop.
    function sendLeaveAndClose(socket: WebSocket): void {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(packProtocol({ type: 'leave' }));
            socket.close(4000, 'consented leave');
        } else {
            socket.close();
        }
    }

    // best-effort __leave on tab close / navigation.
    // if the browser gives us time, the server sees 4000 (CONSENTED).
    // if not, the server sees 1001 (GOING_AWAY) and onDrop fires.
    function onBeforeUnload(): void {
        if (ws && state === 'open') {
            sendLeaveAndClose(ws);
        }
    }

    // register unload handlers (browser only)
    if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('beforeunload', onBeforeUnload);
        globalThis.addEventListener('pagehide', onBeforeUnload);
    }

    // remove unload handlers
    function removeUnloadHandlers(): void {
        if (typeof globalThis.removeEventListener === 'function') {
            globalThis.removeEventListener('beforeunload', onBeforeUnload);
            globalThis.removeEventListener('pagehide', onBeforeUnload);
        }
    }

    // transition to CLOSED permanently
    function enterClosed(code: number, reason: string): void {
        state = 'closed';
        clearTimers();
        removeUnloadHandlers();
        ws = null;
        // clear outbound buffer
        reliableBuffer.length = 0;
        reliableBufferBytes = 0;
        emit('close', code, reason);
    }

    // --- websocket wiring ---

    // wire up event handlers on a websocket instance.
    // isReconnect: true when this ws was opened as part of a reconnection attempt.
    function wireSocket(socket: WebSocket, isReconnect: boolean): void {
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
            if (state === 'closed') {
                // user called close() while we were connecting
                socket.close();
                return;
            }

            if (!isReconnect) {
                // initial connection — transition to OPEN will happen when
                // we receive __session token, but fire 'open' now since
                // the ws is connected. actually, per existing behavior,
                // 'open' fires on ws open for the initial connection.
                state = 'open';
                openedAt = Date.now();

                // start minUptime timer — if we stay open this long, reset retry count
                uptimeTimer = setTimeout(() => {
                    retryCount = 0;
                }, MIN_UPTIME);

                emit('open');
            }
            // for reconnection, we wait for __session to confirm
        };

        socket.onmessage = (event: MessageEvent) => {
            const { data } = event;

            // all gatho frames are binary
            if (!(data instanceof ArrayBuffer)) return;

            const frame = unpackFrame(data);

            if (frame.frame === 'protocol') {
                const msg = frame.message;

                if (msg.type === 'session') {
                    sessionToken = msg.token;

                    if (isReconnect && state === 'reconnecting') {
                        // reconnection confirmed — server accepted our session
                        state = 'open';
                        openedAt = Date.now();

                        // start minUptime timer
                        uptimeTimer = setTimeout(() => {
                            retryCount = 0;
                        }, MIN_UPTIME);

                        // flush outbound reliable buffer before notifying user code
                        flushReliableBuffer(socket);

                        emit('reconnect');
                    }
                    return;
                }

                if (msg.type === 'auth_error') {
                    if (isReconnect && state === 'reconnecting') {
                        // server rejected our session — give up permanently
                        enterClosed(4000, 'session rejected');
                        socket.close();
                        return;
                    }

                    // initial connection auth error
                    emit('authError', msg.error);
                    return;
                }

                // unknown protocol message — ignore
                return;
            }

            if (frame.frame === 'user_text') {
                emit('message', frame.text);
                return;
            }

            if (frame.frame === 'user_binary') {
                emit('message', frame.data);
            }
        };

        socket.onclose = (event: CloseEvent) => {
            // clear the minUptime timer if running
            if (uptimeTimer) {
                clearTimeout(uptimeTimer);
                uptimeTimer = null;
            }

            if (state === 'closed') {
                // already closed — nothing to do
                return;
            }

            if (state === 'connecting') {
                // initial connection failed — permanent close
                enterClosed(event.code, event.reason);
                return;
            }

            if (state === 'reconnecting') {
                // a reconnect attempt's ws closed — failed attempt, try again
                startReconnect();
                return;
            }

            // state === 'open'
            if (event.code === 4000) {
                // consented close — permanent
                enterClosed(event.code, event.reason);
                return;
            }

            // unexpected drop — start reconnection if we have a session token
            if (sessionToken) {
                state = 'reconnecting';
                ws = null;

                // check if minUptime was met — if the connection was open long enough,
                // reset retry count (it would have been reset by the timer, but the
                // timer may not have fired yet)
                if (openedAt && Date.now() - openedAt >= MIN_UPTIME) {
                    retryCount = 0;
                }

                emit('drop');
                startReconnect();
            } else {
                // no session token — can't reconnect
                enterClosed(event.code, event.reason);
            }
        };

        socket.onerror = (event: Event) => {
            emit('error', event);
        };
    }

    // --- reconnection loop ---

    function startReconnect(): void {
        if (state !== 'reconnecting') return;

        retryCount++;
        const delay = computeDelay(retryCount);

        backoffTimer = setTimeout(() => {
            backoffTimer = null;

            if (state !== 'reconnecting') return;
            if (!sessionToken) {
                enterClosed(1006, 'no session token');
                return;
            }

            const reconnectUrl = buildReconnectUrl(url, sessionToken);
            const newWs = new WebSocket(reconnectUrl);

            ws = newWs;
            wireSocket(newWs, true);
        }, delay);
    }

    // --- create initial websocket ---

    ws = new WebSocket(url);
    wireSocket(ws, false);

    // --- return the RoomConnection ---

    return {
        get state(): ConnectionState {
            return state;
        },

        send(message: SendMessage, options?: SendOptions): void {
            const reliable = options?.reliable !== false;

            if (state === 'open' && ws) {
                // connected — frame and send immediately
                ws.send(frameUserMessage(message));
                return;
            }

            if (state === 'reconnecting' && reliable) {
                // disconnected, reliable — buffer
                bufferReliable(message);
                return;
            }

            // CLOSED, CONNECTING, or unreliable during RECONNECTING — silently drop
        },

        on(event: string, callback: (...args: never[]) => void): () => void {
            const set = listeners[event as keyof ListenerMap];
            if (!set) return () => {};
            set.add(callback);
            return () => {
                set.delete(callback);
            };
        },

        off(event: string, callback: (...args: never[]) => void): void {
            const set = listeners[event as keyof ListenerMap];
            if (!set) return;
            set.delete(callback);
        },

        close(): void {
            if (state === 'closed') return;

            if (state === 'open' && ws) {
                sendLeaveAndClose(ws);
                // enterClosed will be called from the onclose handler
                return;
            }

            if (state === 'reconnecting') {
                // stop the backoff loop — enter CLOSED
                // the server's disconnect timer (if allowReconnection was called)
                // will eventually fire onLeave
                if (ws) {
                    ws.onclose = null;
                    ws.onerror = null;
                    ws.onmessage = null;
                    ws.onopen = null;
                    ws.close();
                }
                enterClosed(4000, 'client closed during reconnection');
                return;
            }

            if (state === 'connecting' && ws) {
                ws.onclose = null;
                ws.onerror = null;
                ws.onmessage = null;
                ws.onopen = null;
                ws.close();
                enterClosed(4000, 'client closed during connect');
                return;
            }
        },
    };
}
