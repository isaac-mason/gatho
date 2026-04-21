import { frameUserMessage, unpackFrame, packProtocol } from 'gatho/common';

// backoff constants — hardcoded, always right
const MIN_DELAY = 1000;
const MAX_DELAY = 10000;
const BACKOFF_FACTOR = 1.5;
const MIN_UPTIME = 5000;
// outbound reliable message buffer cap — 1mb
const MAX_BUFFER_BYTES = 1_048_576;
// compute backoff delay with jitter
function computeDelay(retryCount) {
    const base = MIN_DELAY * BACKOFF_FACTOR ** (retryCount - 1);
    // jitter ±50%
    const jittered = base * (0.5 + Math.random());
    return Math.min(jittered, MAX_DELAY);
}
// build the reconnect url by appending ?session=<token> or &session=<token>
function buildReconnectUrl(originalUrl, sessionToken) {
    const separator = originalUrl.includes('?') ? '&' : '?';
    return `${originalUrl}${separator}session=${sessionToken}`;
}
// connect to a gatho room. url is the full websocket url with token
// baked in as a query param, e.g. "ws://localhost:9001?token=..."
// returned by sdk.join().url
function connect(url) {
    // --- mutable state ---
    let state = 'connecting';
    let ws = null;
    let sessionToken = null;
    let retryCount = 0;
    let uptimeTimer = null;
    let backoffTimer = null;
    // track the open timestamp so minUptime is checked on drop
    let openedAt = null;
    // outbound reliable message buffer — messages queued during RECONNECTING
    const reliableBuffer = [];
    let reliableBufferBytes = 0;
    const listeners = {
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
    function estimateByteSize(message) {
        if (typeof message === 'string')
            return message.length * 2;
        if (message instanceof Blob)
            return message.size;
        if (message instanceof ArrayBuffer)
            return message.byteLength;
        // ArrayBufferView (Uint8Array, Float32Array, etc.)
        return message.byteLength;
    }
    // buffer a reliable message. if the buffer overflows, transition to CLOSED.
    function bufferReliable(message) {
        const byteSize = estimateByteSize(message);
        reliableBuffer.push({ payload: message, byteSize });
        reliableBufferBytes += byteSize;
        if (reliableBufferBytes > MAX_BUFFER_BYTES) {
            enterClosed(1009, 'outbound buffer overflow');
        }
    }
    // flush the reliable buffer over the current websocket, then clear it
    function flushReliableBuffer(socket) {
        for (const buffered of reliableBuffer) {
            socket.send(frameUserMessage(buffered.payload));
        }
        reliableBuffer.length = 0;
        reliableBufferBytes = 0;
    }
    function emit(event, ...args) {
        const set = listeners[event];
        for (const cb of set)
            cb(...args);
    }
    function clearTimers() {
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
    function sendLeaveAndClose(socket) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(packProtocol({ type: 'leave' }));
            socket.close(4000, 'consented leave');
        }
        else {
            socket.close();
        }
    }
    // best-effort __leave on tab close / navigation.
    // if the browser gives us time, the server sees 4000 (CONSENTED).
    // if not, the server sees 1001 (GOING_AWAY) and onDrop fires.
    function onBeforeUnload() {
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
    function removeUnloadHandlers() {
        if (typeof globalThis.removeEventListener === 'function') {
            globalThis.removeEventListener('beforeunload', onBeforeUnload);
            globalThis.removeEventListener('pagehide', onBeforeUnload);
        }
    }
    // transition to CLOSED permanently
    function enterClosed(code, reason) {
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
    function wireSocket(socket, isReconnect) {
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
        socket.onmessage = (event) => {
            const { data } = event;
            // all gatho frames are binary
            if (!(data instanceof ArrayBuffer))
                return;
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
        socket.onclose = (event) => {
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
            }
            else {
                // no session token — can't reconnect
                enterClosed(event.code, event.reason);
            }
        };
        socket.onerror = (event) => {
            emit('error', event);
        };
    }
    // --- reconnection loop ---
    function startReconnect() {
        if (state !== 'reconnecting')
            return;
        retryCount++;
        const delay = computeDelay(retryCount);
        backoffTimer = setTimeout(() => {
            backoffTimer = null;
            if (state !== 'reconnecting')
                return;
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
        get state() {
            return state;
        },
        send(message, options) {
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
        on(event, callback) {
            const set = listeners[event];
            if (!set)
                return () => { };
            set.add(callback);
            return () => {
                set.delete(callback);
            };
        },
        off(event, callback) {
            const set = listeners[event];
            if (!set)
                return;
            set.delete(callback);
        },
        close() {
            if (state === 'closed')
                return;
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

export { connect };
//# sourceMappingURL=client.js.map
