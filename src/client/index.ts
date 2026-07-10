import { CloseCode } from '../common/close-code';
import { frameUserMessage, packProtocol, PROTOCOL_VERSION, unpackFrame } from '../common/protocol';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type SendOptions = { reliable?: boolean };

// outbound message — mirrors WebSocket.send() accepted types
export type SendMessage = string | ArrayBuffer | ArrayBufferView | Blob;

// inbound message — mirrors MessageEvent.data with binaryType 'arraybuffer'
export type ReceiveMessage = string | ArrayBuffer;

// why the connection reached its terminal CLOSED state. lets the app react
// without decoding raw close codes:
//   'consented'              — the app called close() (intentional departure).
//   'auth'                   — the room rejected the initial connect (auth_error).
//   'session'                — the room rejected our session on reconnect.
//   'reconnect-failed'       — reconnection gave up after the attempt cap.
//   'buffer-overflow'        — the outbound reliable buffer exceeded its cap.
//   'initial-connect-failed' — the initial ws closed before a session arrived.
//   'server'                 — the server closed a live, authenticated connection.
export type CloseCause =
    | 'consented'
    | 'auth'
    | 'session'
    | 'reconnect-failed'
    | 'buffer-overflow'
    | 'initial-connect-failed'
    | 'server';

// payload delivered to close listeners.
export type CloseInfo = { code: number; reason: string; cause: CloseCause };

type BufferedMessage = {
    payload: SendMessage;
    byteSize: number;
};

// single-handler bag declared at connect(). one handler per event, all optional.
// the socket is not an app-wide event bus — app code fans out from these.
export type ConnectHandlers = {
    // fires when the connection is authenticated and joined — on receipt of the
    // first `session` protocol message. this is the client-side view of the same
    // protocol instant as the room's `onJoin`.
    onOpen?: () => void;
    // a message frame arrived from the room.
    onMessage?: (message: ReceiveMessage) => void;
    // the live connection dropped (non-consented). reconnection begins automatically.
    onDrop?: () => void;
    // a dropped connection was re-established (session resumed).
    onReconnect?: () => void;
    // the room rejected the initial connect with an auth error.
    onAuthError?: (error: unknown) => void;
    // the connection reached its terminal CLOSED state. see CloseInfo.cause.
    onClose?: (info: CloseInfo) => void;
    // a low-level websocket error event.
    onError?: (error: Event) => void;
};

export type RoomConnection = {
    // current connection state
    readonly state: ConnectionState;

    // this client's id, assigned by the room. null until the first `session`
    // protocol message arrives (i.e. until the connection is authenticated).
    readonly clientId: string | null;

    // send a message to the server.
    // if message is Uint8Array or ArrayBuffer, sends as binary, otherwise JSON-serialized.
    // reliable (default true): buffered during CONNECTING and RECONNECTING, flushed in
    // order once the connection is established (open). unreliable: drops unless OPEN.
    send(message: SendMessage, options?: SendOptions): void;

    // close the connection. sends __leave protocol message before closing
    // with code 4000 (consented), telling the server this is intentional.
    // if RECONNECTING, stops the backoff loop and enters CLOSED.
    close(): void;
};

// backoff constants — hardcoded, always right
const MIN_DELAY = 1000;
const MAX_DELAY = 10000;
const BACKOFF_FACTOR = 1.5;
const MIN_UPTIME = 5000;

// reconnection attempt cap. after this many consecutive failed reconnect
// attempts, give up and enter a terminal close — the signal a game needs to
// re-matchmake. resets to zero on a successful reconnect (session receipt).
const MAX_RECONNECT_ATTEMPTS = 10;

// outbound reliable message buffer cap — 1mb
const MAX_BUFFER_BYTES = 1_048_576;

// compute backoff delay with jitter
function computeDelay(retryCount: number): number {
    const base = MIN_DELAY * BACKOFF_FACTOR ** (retryCount - 1);
    // jitter ±50%
    const jittered = base * (0.5 + Math.random());
    return Math.min(jittered, MAX_DELAY);
}

// append a query param to a url, choosing ? or & based on what's already there.
function appendParam(url: string, key: string, value: string): string {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${key}=${value}`;
}

// stamp the protocol version onto a connect url. the room rejects any connect
// whose gv is missing or mismatched, so both initial connect and reconnect
// carry it.
function withProtocolVersion(url: string): string {
    return appendParam(url, 'gv', String(PROTOCOL_VERSION));
}

// build the reconnect url by appending session + protocol version.
function buildReconnectUrl(originalUrl: string, sessionToken: string): string {
    return withProtocolVersion(appendParam(originalUrl, 'session', sessionToken));
}

// connect to a gatho room. url is the full websocket url with token
// baked in as a query param, e.g. "ws://localhost:9001?token=..."
// returned by sdk.join().url. handlers is a single-handler bag — one handler
// per event, all optional.
export function connect(url: string, handlers: ConnectHandlers = {}): RoomConnection {
    // --- mutable state ---
    let state: ConnectionState = 'connecting';
    let ws: WebSocket | null = null;
    let sessionToken: string | null = null;
    // this client's id, learned from the first `session` protocol message.
    let clientId: string | null = null;
    let retryCount = 0;
    let uptimeTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;
    // track the open timestamp so minUptime is checked on drop
    let openedAt: number | null = null;
    // set when the initial connect receives auth_error. the room follows the
    // auth_error with a 4000 close; this flag lets the onclose handler map that
    // close to cause 'auth' rather than 'initial-connect-failed'.
    let initialAuthFailed = false;
    // set when the app calls close() on an open connection. lets the onclose
    // handler distinguish a consented client-initiated 4000 from a server-
    // initiated 4000 (e.g. eviction).
    let consentedClose = false;

    // outbound reliable message buffer — messages queued during CONNECTING and
    // RECONNECTING, flushed in order once the connection is established.
    const reliableBuffer: BufferedMessage[] = [];
    let reliableBufferBytes = 0;

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
            enterClosed(1009, 'outbound buffer overflow', 'buffer-overflow');
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
            socket.close(CloseCode.CONSENTED, 'consented leave');
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

    // transition to CLOSED permanently. any messages buffered while connecting
    // or reconnecting are discarded — a terminal close means they will never be
    // delivered.
    function enterClosed(code: number, reason: string, cause: CloseCause): void {
        state = 'closed';
        clearTimers();
        removeUnloadHandlers();
        ws = null;
        // clear outbound buffer
        reliableBuffer.length = 0;
        reliableBufferBytes = 0;
        handlers.onClose?.({ code, reason, cause });
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
            // both the initial connect and reconnect defer the open/reconnect
            // transition to the `session` protocol message. a raw ws open means
            // the socket is connected but not yet authenticated or joined, so we
            // do nothing here and wait for `session`. this makes open mean
            // "authenticated and joined" and symmetrizes with the reconnect path.
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
                    clientId = msg.clientId;

                    if (isReconnect && state === 'reconnecting') {
                        // reconnection confirmed — server accepted our session.
                        // reset the attempt counter now that we are authenticated
                        // and joined again.
                        state = 'open';
                        retryCount = 0;
                        openedAt = Date.now();

                        // start minUptime timer
                        uptimeTimer = setTimeout(() => {
                            retryCount = 0;
                        }, MIN_UPTIME);

                        // flush outbound reliable buffer before notifying user code
                        flushReliableBuffer(socket);

                        handlers.onReconnect?.();
                        return;
                    }

                    if (!isReconnect && state === 'connecting') {
                        // initial connection confirmed — the client is now
                        // authenticated and joined. minUptime timer starts here,
                        // at session receipt, not at raw ws open.
                        state = 'open';
                        openedAt = Date.now();

                        // start minUptime timer
                        uptimeTimer = setTimeout(() => {
                            retryCount = 0;
                        }, MIN_UPTIME);

                        // flush anything buffered while connecting, in order,
                        // BEFORE emitting open (mirrors the reconnect path).
                        flushReliableBuffer(socket);

                        handlers.onOpen?.();
                        return;
                    }
                    return;
                }

                if (msg.type === 'auth_error') {
                    if (isReconnect && state === 'reconnecting') {
                        // server rejected our session — give up permanently
                        socket.close();
                        enterClosed(CloseCode.CONSENTED, 'session rejected', 'session');
                        return;
                    }

                    // initial connection auth error. open was never emitted
                    // (it is deferred to session), so no 'open' leaks. surface
                    // the error and mark the auth failure so the follow-up 4000
                    // close maps to cause 'auth'.
                    initialAuthFailed = true;
                    handlers.onAuthError?.(msg.error);
                    return;
                }

                // unknown protocol message — ignore
                return;
            }

            if (frame.frame === 'user_text') {
                handlers.onMessage?.(frame.text);
                return;
            }

            if (frame.frame === 'user_binary') {
                handlers.onMessage?.(frame.data);
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
                // initial connection ended before a session arrived. if the
                // room sent auth_error first, this is an auth rejection;
                // otherwise the socket closed before authenticating.
                if (initialAuthFailed) {
                    enterClosed(event.code, event.reason, 'auth');
                } else {
                    enterClosed(event.code, event.reason, 'initial-connect-failed');
                }
                return;
            }

            if (state === 'reconnecting') {
                // a reconnect attempt's ws closed — failed attempt, try again
                startReconnect();
                return;
            }

            // state === 'open'
            if (event.code === CloseCode.CONSENTED) {
                // a 4000 close on a live connection. if the app called close()
                // this is a consented departure; otherwise the server closed us
                // (e.g. eviction, kick) — those read as 'server'.
                enterClosed(event.code, event.reason, consentedClose ? 'consented' : 'server');
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

                handlers.onDrop?.();
                startReconnect();
            } else {
                // no session token — can't reconnect. the server closed a live
                // connection we cannot resume.
                enterClosed(event.code, event.reason, 'server');
            }
        };

        socket.onerror = (event: Event) => {
            handlers.onError?.(event);
        };
    }

    // --- reconnection loop ---

    function startReconnect(): void {
        if (state !== 'reconnecting') return;

        if (retryCount >= MAX_RECONNECT_ATTEMPTS) {
            // gave up — enter a terminal close the app can react to (e.g. by
            // re-matchmaking). 1006 is the abnormal-closure code.
            enterClosed(1006, 'reconnection attempts exhausted', 'reconnect-failed');
            return;
        }

        retryCount++;
        const delay = computeDelay(retryCount);

        backoffTimer = setTimeout(() => {
            backoffTimer = null;

            if (state !== 'reconnecting') return;
            if (!sessionToken) {
                enterClosed(1006, 'no session token', 'server');
                return;
            }

            const reconnectUrl = buildReconnectUrl(url, sessionToken);
            const newWs = new WebSocket(reconnectUrl);

            ws = newWs;
            wireSocket(newWs, true);
        }, delay);
    }

    // --- create initial websocket ---

    ws = new WebSocket(withProtocolVersion(url));
    wireSocket(ws, false);

    // --- return the RoomConnection ---

    return {
        get state(): ConnectionState {
            return state;
        },

        get clientId(): string | null {
            return clientId;
        },

        send(message: SendMessage, options?: SendOptions): void {
            const reliable = options?.reliable !== false;

            if (state === 'open' && ws) {
                // connected — frame and send immediately
                ws.send(frameUserMessage(message));
                return;
            }

            if ((state === 'connecting' || state === 'reconnecting') && reliable) {
                // not yet established (or dropped), reliable — buffer and flush
                // in order once the connection is (re)established.
                bufferReliable(message);
                return;
            }

            // CLOSED, or unreliable during CONNECTING/RECONNECTING — silently drop
        },

        close(): void {
            if (state === 'closed') return;

            if (state === 'open' && ws) {
                // mark the consented close so the onclose handler reports
                // cause 'consented' for the resulting 4000.
                consentedClose = true;
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
                enterClosed(CloseCode.CONSENTED, 'client closed during reconnection', 'consented');
                return;
            }

            if (state === 'connecting' && ws) {
                ws.onclose = null;
                ws.onerror = null;
                ws.onmessage = null;
                ws.onopen = null;
                ws.close();
                enterClosed(CloseCode.CONSENTED, 'client closed during connect', 'consented');
                return;
            }
        },
    };
}
