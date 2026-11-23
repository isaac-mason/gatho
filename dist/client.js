// --- close codes ---
// websocket close codes that gatho uses to distinguish disconnect reasons.
// lives in common/ so both the client and the room can share the constant
// without the client importing gatho/room. gatho/room re-exports it unchanged.
// 4000 (CONSENTED) = the client explicitly called close() — sent __leave first.
// everything else fires onDrop, giving the room code a chance to call allowReconnection.
const CloseCode = {
    CONSENTED: 4000,
};

// binary wire primitives shared by the control and notify protocols.
//
// there is deliberately no schema layer here: each protocol writes its own
// messages field by field with these helpers.
//
// encoding is single pass into a reused scratch buffer, copied out once at the
// end. decoding reads from a reused cursor and bounds-checks every read against
// the end of the payload, throwing an Error on anything malformed.
//
// numbers are little endian. lengths and counts are unsigned LEB128 varints.
// strings are a varint byte length followed by utf-8 bytes.
const INITIAL_CAPACITY = 4096;
// a scratch buffer grown beyond this is dropped after the encode that grew it
const MAX_RETAINED_CAPACITY = 1 << 20;
// strings shorter than this many utf-16 units encode to under 128 bytes
// (3 bytes per unit worst case), so their length varint is always one byte
const SHORT_STRING_UNITS = 43;
// strings up to this many bytes decode with the inline ascii loop
const ASCII_DECODE_MAX_BYTES = 16;
const textEncoder$1 = new TextEncoder();
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const EMPTY = new Uint8Array(0);
/** utf-8 byte length of a string, matching `TextEncoder` (lone surrogates are 3 bytes) */
function utf8Length(s) {
    const n = s.length;
    let bytes = 0;
    for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) {
            bytes += 1;
        }
        else if (c < 0x800) {
            bytes += 2;
        }
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                bytes += 4;
                i++;
            }
            else {
                bytes += 3;
            }
        }
        else {
            bytes += 3;
        }
    }
    return bytes;
}
class Writer {
    buf = new Uint8Array(INITIAL_CAPACITY);
    view = new DataView(this.buf.buffer);
    pos = 0;
    /** start a new message, discarding anything written by an encode that threw */
    begin() {
        this.pos = 0;
    }
    /** make room for `n` more bytes */
    ensure(n) {
        const needed = this.pos + n;
        if (needed <= this.buf.length)
            return;
        let capacity = this.buf.length * 2;
        while (capacity < needed)
            capacity *= 2;
        const next = new Uint8Array(capacity);
        next.set(this.buf.subarray(0, this.pos));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }
    u8(value) {
        this.ensure(1);
        this.buf[this.pos++] = value;
    }
    /** u16 little endian. throws when the value is not an integer in 0..65535 */
    u16(value) {
        if ((value & 0xffff) !== value) {
            throw new RangeError(`value ${value} is not a uint16`);
        }
        this.ensure(2);
        const buf = this.buf;
        const pos = this.pos;
        buf[pos] = value & 0xff;
        buf[pos + 1] = value >>> 8;
        this.pos = pos + 2;
    }
    f64(value) {
        this.ensure(8);
        this.view.setFloat64(this.pos, value, true);
        this.pos += 8;
    }
    /** unsigned LEB128, value must be an integer in 0..2^32-1 */
    varint(value) {
        this.ensure(5);
        const buf = this.buf;
        let pos = this.pos;
        while (value >= 0x80) {
            buf[pos++] = (value & 0x7f) | 0x80;
            value >>>= 7;
        }
        buf[pos++] = value;
        this.pos = pos;
    }
    /** varint byte length followed by utf-8 bytes */
    str(s) {
        const n = s.length;
        if (n < SHORT_STRING_UNITS) {
            this.ensure(1 + n * 3);
            const buf = this.buf;
            const lengthPos = this.pos;
            let pos = lengthPos + 1;
            for (let i = 0; i < n; i++) {
                let c = s.charCodeAt(i);
                if (c < 0x80) {
                    buf[pos++] = c;
                }
                else if (c < 0x800) {
                    buf[pos++] = 0xc0 | (c >> 6);
                    buf[pos++] = 0x80 | (c & 0x3f);
                }
                else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
                    const d = s.charCodeAt(i + 1);
                    if (d >= 0xdc00 && d <= 0xdfff) {
                        const codePoint = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                        buf[pos++] = 0xf0 | (codePoint >> 18);
                        buf[pos++] = 0x80 | ((codePoint >> 12) & 0x3f);
                        buf[pos++] = 0x80 | ((codePoint >> 6) & 0x3f);
                        buf[pos++] = 0x80 | (codePoint & 0x3f);
                        i++;
                    }
                    else {
                        buf[pos++] = 0xef;
                        buf[pos++] = 0xbf;
                        buf[pos++] = 0xbd;
                    }
                }
                else {
                    // a lone surrogate encodes as U+FFFD, same as TextEncoder
                    if (c >= 0xd800 && c <= 0xdfff)
                        c = 0xfffd;
                    buf[pos++] = 0xe0 | (c >> 12);
                    buf[pos++] = 0x80 | ((c >> 6) & 0x3f);
                    buf[pos++] = 0x80 | (c & 0x3f);
                }
            }
            buf[lengthPos] = pos - lengthPos - 1;
            this.pos = pos;
            return;
        }
        const byteLength = utf8Length(s);
        this.varint(byteLength);
        this.ensure(byteLength);
        const { written } = textEncoder$1.encodeInto(s, this.buf.subarray(this.pos, this.pos + byteLength));
        if (written !== byteLength) {
            throw new Error('utf-8 length mismatch while encoding a string');
        }
        this.pos += byteLength;
    }
    /** write a count whose value is only known after its items were written.
     *  reserve it with `reserveCount` before the items. */
    reserveCount() {
        const at = this.pos;
        this.u8(0);
        return at;
    }
    /** fill in a count reserved with `reserveCount`, widening it if it needs more than one byte */
    patchCount(at, count) {
        if (count < 0x80) {
            this.buf[at] = count;
            return;
        }
        let width = 1;
        for (let rest = count >>> 7; rest > 0; rest >>>= 7)
            width++;
        this.ensure(width - 1);
        const buf = this.buf;
        buf.copyWithin(at + width, at + 1, this.pos);
        this.pos += width - 1;
        let value = count;
        let p = at;
        while (value >= 0x80) {
            buf[p++] = (value & 0x7f) | 0x80;
            value >>>= 7;
        }
        buf[p] = value;
    }
    /** copy the written bytes out into one exact-size array and reset */
    finish() {
        const out = this.buf.slice(0, this.pos);
        this.release();
        return out;
    }
    release() {
        this.pos = 0;
        if (this.buf.length > MAX_RETAINED_CAPACITY) {
            this.buf = new Uint8Array(INITIAL_CAPACITY);
            this.view = new DataView(this.buf.buffer);
        }
    }
}
class Reader {
    buf = EMPTY;
    pos = 0;
    end = 0;
    view = null;
    /** start reading `bytes` at offset `start` */
    reset(bytes, start) {
        this.buf = bytes;
        this.pos = start;
        this.end = bytes.byteLength;
        this.view = null;
    }
    /** drop the reference to the input buffer */
    release() {
        this.buf = EMPTY;
        this.view = null;
    }
    need(n) {
        if (this.end - this.pos < n) {
            throw new Error('unexpected end of input');
        }
    }
    u8() {
        if (this.pos >= this.end)
            throw new Error('unexpected end of input');
        return this.buf[this.pos++];
    }
    u16() {
        this.need(2);
        const value = this.buf[this.pos] | (this.buf[this.pos + 1] << 8);
        this.pos += 2;
        return value;
    }
    f64() {
        this.need(8);
        if (this.view === null) {
            this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
        }
        const value = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return value;
    }
    /** unsigned LEB128 below 2^32, overlong encodings rejected */
    varint() {
        if (this.pos >= this.end)
            throw new Error('unexpected end of input');
        const first = this.buf[this.pos];
        if (first < 0x80) {
            this.pos++;
            return first;
        }
        return this.varintMultiByte();
    }
    varintMultiByte() {
        const buf = this.buf;
        const end = this.end;
        let pos = this.pos;
        let value = 0;
        for (let shift = 0; shift < 35; shift += 7) {
            if (pos >= end)
                throw new Error('unexpected end of input');
            const byte = buf[pos++];
            // the fifth byte only has room for the top 4 bits of a uint32
            if (shift === 28 && byte > 0x0f)
                throw new Error('varint exceeds uint32');
            value += (byte & 0x7f) * 2 ** shift;
            if (byte < 0x80) {
                if (byte === 0 && shift > 0)
                    throw new Error('overlong varint');
                this.pos = pos;
                return value;
            }
        }
        throw new Error('varint exceeds uint32');
    }
    /** a list or record entry count, rejected when the remaining input cannot hold that many items */
    count(minItemBytes) {
        const count = this.varint();
        if (count * minItemBytes > this.end - this.pos) {
            throw new Error(`count ${count} exceeds remaining input`);
        }
        return count;
    }
    str() {
        const length = this.varint();
        const start = this.pos;
        if (length > this.end - start) {
            throw new Error(`string length ${length} exceeds remaining input`);
        }
        this.pos = start + length;
        if (length === 0)
            return '';
        if (length <= ASCII_DECODE_MAX_BYTES) {
            const buf = this.buf;
            let s = '';
            for (let i = start; i < start + length; i++) {
                const c = buf[i];
                if (c >= 0x80)
                    return this.decodeUtf8(start, length);
                s += String.fromCharCode(c);
            }
            return s;
        }
        return this.decodeUtf8(start, length);
    }
    decodeUtf8(start, length) {
        try {
            return strictTextDecoder.decode(this.buf.subarray(start, start + length));
        }
        catch {
            throw new Error('invalid utf-8 in string');
        }
    }
    /** throw if any bytes remain after a message */
    finish() {
        if (this.pos !== this.end) {
            throw new Error(`${this.end - this.pos} trailing bytes after message`);
        }
    }
}

// wire framing for gatho websocket connections.
//
// every websocket message is a binary frame. byte 0 is the frame type:
//   0x00 = protocol message (tag byte and fields follow)
//   0x01 = user text message (raw utf-8 bytes follow)
//   0x02 = user binary message (raw bytes follow)
//
// protocol messages are hand-encoded, see the layouts on the tag constants.
// user messages pass through with minimal overhead (1 byte prefix).
// gatho wire protocol version. client and server versions must match exactly,
// the room rejects any connect whose `gv` query param is missing or different.
// bump this on any breaking change to the frame layout or protocol messages.
const PROTOCOL_VERSION = 2;
// frame type constants
const FRAME_PROTOCOL = 0x00;
const FRAME_USER_TEXT = 0x01;
const FRAME_USER_BINARY = 0x02;
// protocol message tags, the byte after the frame type
//   0 session:    str token, str clientId
//   1 auth_error: str error
//   2 leave:      no fields
// where str is a varint byte length followed by utf-8 bytes
const TAG_SESSION = 0;
const TAG_AUTH_ERROR = 1;
const TAG_LEAVE = 2;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const writer = new Writer();
const reader = new Reader();
// pack a protocol message: [0x00, tag, ...fields]
function packProtocol(msg) {
    writer.begin();
    writer.u8(FRAME_PROTOCOL);
    switch (msg.type) {
        case 'session':
            writer.u8(TAG_SESSION);
            writer.str(msg.token);
            writer.str(msg.clientId);
            break;
        case 'auth_error':
            writer.u8(TAG_AUTH_ERROR);
            writer.str(msg.error);
            break;
        case 'leave':
            writer.u8(TAG_LEAVE);
            break;
        default:
            throw new Error(`unknown protocol message type: ${msg.type}`);
    }
    return writer.finish();
}
// decode the protocol message whose tag byte is at `offset`
function unpackProtocolMessage(view, offset) {
    reader.reset(view, offset);
    try {
        const tag = reader.u8();
        let message;
        switch (tag) {
            case TAG_SESSION: {
                const token = reader.str();
                const clientId = reader.str();
                message = { type: 'session', token, clientId };
                break;
            }
            case TAG_AUTH_ERROR:
                message = { type: 'auth_error', error: reader.str() };
                break;
            case TAG_LEAVE:
                message = { type: 'leave' };
                break;
            default:
                throw new Error(`unknown protocol message tag: 0x${tag.toString(16).padStart(2, '0')}`);
        }
        reader.finish();
        return message;
    }
    finally {
        reader.release();
    }
}
// pack a user text message: [0x01, ...utf-8 bytes]
function packUserText(text) {
    const encoded = textEncoder.encode(text);
    const frame = new Uint8Array(1 + encoded.byteLength);
    frame[0] = FRAME_USER_TEXT;
    frame.set(encoded, 1);
    return frame;
}
// pack a user binary message: [0x02, ...raw bytes]
function packUserBinary(data) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const frame = new Uint8Array(1 + view.byteLength);
    frame[0] = FRAME_USER_BINARY;
    frame.set(view, 1);
    return frame;
}
// unpack any frame. accepts ArrayBuffer or Uint8Array.
function unpackFrame(data) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (view.byteLength === 0) {
        throw new Error('empty frame');
    }
    const type = view[0];
    switch (type) {
        case FRAME_PROTOCOL:
            return { frame: 'protocol', message: unpackProtocolMessage(view, 1) };
        case FRAME_USER_TEXT:
            return { frame: 'user_text', text: textDecoder.decode(view.subarray(1)) };
        case FRAME_USER_BINARY:
            // return a copy as ArrayBuffer so the caller owns the memory
            return {
                frame: 'user_binary',
                data: view.slice(1).buffer,
            };
        default:
            throw new Error(`unknown frame type: 0x${type.toString(16).padStart(2, '0')}`);
    }
}
function frameUserMessage(message) {
    if (typeof message === 'string')
        return packUserText(message);
    if (message instanceof ArrayBuffer)
        return packUserBinary(message);
    if (message instanceof Blob) {
        // blob should have been converted before reaching here — this is a
        // fallback that shouldn't happen in practice. callers should await
        // blob.arrayBuffer() first.
        throw new Error('Blob must be converted to ArrayBuffer before framing');
    }
    // ArrayBufferView (Uint8Array, Float32Array, etc.)
    return packUserBinary(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
}

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
function computeDelay(retryCount) {
    const base = MIN_DELAY * BACKOFF_FACTOR ** (retryCount - 1);
    // jitter ±50%
    const jittered = base * (0.5 + Math.random());
    return Math.min(jittered, MAX_DELAY);
}
// append a query param to a url, choosing ? or & based on what's already there.
function appendParam(url, key, value) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${key}=${value}`;
}
// stamp the protocol version onto a connect url. the room rejects any connect
// whose gv is missing or mismatched, so both initial connect and reconnect
// carry it.
function withProtocolVersion(url) {
    return appendParam(url, 'gv', String(PROTOCOL_VERSION));
}
// build the reconnect url by appending session + protocol version.
function buildReconnectUrl(originalUrl, sessionToken) {
    return withProtocolVersion(appendParam(originalUrl, 'session', sessionToken));
}
// connect to a gatho room. url is the full websocket url with token
// baked in as a query param, e.g. "ws://localhost:9001?token=..."
// returned by sdk.join().url. handlers is a single-handler bag — one handler
// per event, all optional.
function connect(url, handlers = {}) {
    // --- mutable state ---
    let state = 'connecting';
    let ws = null;
    let sessionToken = null;
    // this client's id, learned from the first `session` protocol message.
    let clientId = null;
    let retryCount = 0;
    let uptimeTimer = null;
    let backoffTimer = null;
    // track the open timestamp so minUptime is checked on drop
    let openedAt = null;
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
    const reliableBuffer = [];
    let reliableBufferBytes = 0;
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
            enterClosed(1009, 'outbound buffer overflow', 'buffer-overflow');
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
            socket.close(CloseCode.CONSENTED, 'consented leave');
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
    // transition to CLOSED permanently. any messages buffered while connecting
    // or reconnecting are discarded — a terminal close means they will never be
    // delivered.
    function enterClosed(code, reason, cause) {
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
    function wireSocket(socket, isReconnect) {
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
                // initial connection ended before a session arrived. if the
                // room sent auth_error first, this is an auth rejection;
                // otherwise the socket closed before authenticating.
                if (initialAuthFailed) {
                    enterClosed(event.code, event.reason, 'auth');
                }
                else {
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
            }
            else {
                // no session token — can't reconnect. the server closed a live
                // connection we cannot resume.
                enterClosed(event.code, event.reason, 'server');
            }
        };
        socket.onerror = (event) => {
            handlers.onError?.(event);
        };
    }
    // --- reconnection loop ---
    function startReconnect() {
        if (state !== 'reconnecting')
            return;
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
            if (state !== 'reconnecting')
                return;
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
        get state() {
            return state;
        },
        get clientId() {
            return clientId;
        },
        send(message, options) {
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
        close() {
            if (state === 'closed')
                return;
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

export { connect };
//# sourceMappingURL=client.js.map
