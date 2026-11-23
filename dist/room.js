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

// notify protocol — the room→server notification schema and framing.
//
// messages flow one direction: room → server. the server never speaks back on
// this channel (stop is delivered out-of-band by the runner's destructor).
//
// this module is runtime-neutral on purpose: no Buffer, no node imports. the
// uds and tcp channels both carry these frames; the direct (in-memory) channel
// skips framing and passes messages by reference; non-node runtimes (workerd,
// deno, bun) can use the codec + frame helpers to speak the same protocol.
//
// frame format: length(4 bytes, uint32 BE) + payload(length bytes).
// notify frames carry a hand-encoded NotifyMessage payload (see the wire layout below). the tcp channel
// additionally sends one raw frame first: the utf-8 auth token.
// --- wire layout ---
//
// payload: u8 format, u8 tag, then the fields for the tag. numbers are little
// endian, str is a varint byte length plus utf-8, record is a varint entry
// count followed by (str key, str value) entries.
//
//   0 ready:               u16 port
//   1 heartbeat:           f64 timestamp, u8 hasMetrics (0 or 1),
//                          5 x f64 (rss, heapUsed, heapTotal, cpuUser, cpuSystem) when hasMetrics,
//                          varint clientCount, clientCount x (str clientId, record tags)
//   2 client-connected:    str clientId, str roomId, record tags
//   3 client-disconnected: str clientId
//   4 error:               str message
//   5 stopped:             no fields
//
// the pipe has no version handshake, so the format byte is how a server and
// room built from different gatho versions notice each other. it is above 0x7f
// so it cannot be mistaken for a tag from the older packcat encoding. bump it
// on any breaking change to the layout above.
const NOTIFY_FORMAT = 0x81;
const TAG_READY = 0;
const TAG_HEARTBEAT = 1;
const TAG_CLIENT_CONNECTED = 2;
const TAG_CLIENT_DISCONNECTED = 3;
const TAG_ERROR = 4;
const TAG_STOPPED = 5;
// smallest encodings, used to reject counts the remaining input cannot hold
const MIN_HEARTBEAT_CLIENT_BYTES = 2; // empty clientId length + empty tags count
const MIN_RECORD_ENTRY_BYTES = 2; // empty key length + empty value length
const writer$1 = new Writer();
const reader$1 = new Reader();
function writeTags(tags) {
    const countAt = writer$1.reserveCount();
    let count = 0;
    for (const key in tags) {
        writer$1.str(key);
        writer$1.str(tags[key]);
        count++;
    }
    writer$1.patchCount(countAt, count);
}
function readTags() {
    const count = reader$1.count(MIN_RECORD_ENTRY_BYTES);
    const tags = {};
    for (let i = 0; i < count; i++) {
        const key = reader$1.str();
        const value = reader$1.str();
        if (key === '__proto__') {
            Object.defineProperty(tags, key, { value, writable: true, enumerable: true, configurable: true });
        }
        else {
            tags[key] = value;
        }
    }
    return tags;
}
// write format byte, tag and fields for `msg` at the writer's position
function writeMessage(msg) {
    writer$1.u8(NOTIFY_FORMAT);
    switch (msg.type) {
        case 'ready':
            writer$1.u8(TAG_READY);
            writer$1.u16(msg.port);
            break;
        case 'heartbeat': {
            writer$1.u8(TAG_HEARTBEAT);
            writer$1.f64(msg.timestamp);
            const metrics = msg.metrics;
            if (metrics === undefined) {
                writer$1.u8(0);
            }
            else {
                writer$1.u8(1);
                writer$1.f64(metrics.memoryRss);
                writer$1.f64(metrics.memoryHeapUsed);
                writer$1.f64(metrics.memoryHeapTotal);
                writer$1.f64(metrics.cpuUser);
                writer$1.f64(metrics.cpuSystem);
            }
            const clients = msg.clients;
            writer$1.varint(clients.length);
            for (let i = 0; i < clients.length; i++) {
                const client = clients[i];
                writer$1.str(client.clientId);
                writeTags(client.tags);
            }
            break;
        }
        case 'client-connected':
            writer$1.u8(TAG_CLIENT_CONNECTED);
            writer$1.str(msg.clientId);
            writer$1.str(msg.roomId);
            writeTags(msg.tags);
            break;
        case 'client-disconnected':
            writer$1.u8(TAG_CLIENT_DISCONNECTED);
            writer$1.str(msg.clientId);
            break;
        case 'error':
            writer$1.u8(TAG_ERROR);
            writer$1.str(msg.message);
            break;
        case 'stopped':
            writer$1.u8(TAG_STOPPED);
            break;
        default:
            throw new Error(`unknown notify message type: ${String(msg.type)}`);
    }
}
function readMessage() {
    const format = reader$1.u8();
    if (format !== NOTIFY_FORMAT) {
        throw new Error(`notify format mismatch (got 0x${format.toString(16).padStart(2, '0')}, expected 0x${NOTIFY_FORMAT.toString(16)}), is the room built from a different gatho version?`);
    }
    const tag = reader$1.u8();
    switch (tag) {
        case TAG_READY:
            return { type: 'ready', port: reader$1.u16() };
        case TAG_HEARTBEAT: {
            const timestamp = reader$1.f64();
            const hasMetrics = reader$1.u8();
            let metrics;
            if (hasMetrics === 1) {
                const memoryRss = reader$1.f64();
                const memoryHeapUsed = reader$1.f64();
                const memoryHeapTotal = reader$1.f64();
                const cpuUser = reader$1.f64();
                const cpuSystem = reader$1.f64();
                metrics = { memoryRss, memoryHeapUsed, memoryHeapTotal, cpuUser, cpuSystem };
            }
            else if (hasMetrics !== 0) {
                throw new Error(`invalid heartbeat metrics flag: ${hasMetrics}`);
            }
            const count = reader$1.count(MIN_HEARTBEAT_CLIENT_BYTES);
            const clients = [];
            for (let i = 0; i < count; i++) {
                const clientId = reader$1.str();
                const tags = readTags();
                clients.push({ clientId, tags });
            }
            return { type: 'heartbeat', timestamp, metrics, clients };
        }
        case TAG_CLIENT_CONNECTED: {
            const clientId = reader$1.str();
            const roomId = reader$1.str();
            const tags = readTags();
            return { type: 'client-connected', clientId, roomId, tags };
        }
        case TAG_CLIENT_DISCONNECTED:
            return { type: 'client-disconnected', clientId: reader$1.str() };
        case TAG_ERROR:
            return { type: 'error', message: reader$1.str() };
        case TAG_STOPPED:
            return { type: 'stopped' };
        default:
            throw new Error(`unknown notify message tag: 0x${tag.toString(16).padStart(2, '0')}`);
    }
}
/** encoder and decoder for the notify payload (no length framing) */
const notifyCodec = {
    pack(msg) {
        writer$1.begin();
        writeMessage(msg);
        return writer$1.finish();
    },
    /** decode one payload. throws an Error on anything malformed. */
    unpack(payload) {
        reader$1.reset(payload, 0);
        try {
            const msg = readMessage();
            reader$1.finish();
            return msg;
        }
        finally {
            reader$1.release();
        }
    },
};
// --- framing ---
// header: 4 bytes uint32 BE length
const HEADER_SIZE = 4;
/** wrap raw payload bytes in a length-prefixed frame */
function encodeRawFrame(payload) {
    const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
    frame.set(payload, HEADER_SIZE);
    return frame;
}
/** encode a notify message as a length-prefixed frame, ready to write to any pipe */
function encodeNotifyFrame(msg) {
    writer$1.begin();
    writer$1.ensure(HEADER_SIZE);
    writer$1.pos = HEADER_SIZE;
    writeMessage(msg);
    const payloadLength = writer$1.pos - HEADER_SIZE;
    const frame = writer$1.finish();
    frame[0] = payloadLength >>> 24;
    frame[1] = (payloadLength >>> 16) & 0xff;
    frame[2] = (payloadLength >>> 8) & 0xff;
    frame[3] = payloadLength & 0xff;
    return frame;
}
/** streaming frame parser — handles partial reads and buffering across chunks.
 *  returns a push function that accepts raw chunks and invokes `onFrame` with
 *  each complete payload (header stripped). */
function createFrameParser(onFrame) {
    let buffer = new Uint8Array(0);
    return (data) => {
        if (buffer.byteLength === 0) {
            buffer = data;
        }
        else {
            const merged = new Uint8Array(buffer.byteLength + data.byteLength);
            merged.set(buffer, 0);
            merged.set(data, buffer.byteLength);
            buffer = merged;
        }
        while (buffer.byteLength >= HEADER_SIZE) {
            const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            const payloadLength = view.getUint32(0, false);
            const totalFrameSize = HEADER_SIZE + payloadLength;
            if (buffer.byteLength < totalFrameSize)
                break;
            const payload = buffer.subarray(HEADER_SIZE, totalFrameSize);
            buffer = buffer.subarray(totalFrameSize);
            onFrame(payload);
        }
    };
}

// --- close codes ---
// websocket close codes that gatho uses to distinguish disconnect reasons.
// lives in common/ so both the client and the room can share the constant
// without the client importing gatho/room. gatho/room re-exports it unchanged.
// 4000 (CONSENTED) = the client explicitly called close() — sent __leave first.
// everything else fires onDrop, giving the room code a chance to call allowReconnection.
const CloseCode = {
    NORMAL: 1000,
    GOING_AWAY: 1001,
    ABNORMAL: 1006,
    CONSENTED: 4000,
};

// minimal hmac-sha256 jwt — no external deps.
// single source of truth for sign + verify across drivers and rooms.
//
// built on WebCrypto (async) rather than node:crypto so the verify side runs
// in any runtime a room might be hosted in (node, workerd, deno, bun).
const encoder = new TextEncoder();
function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function fromBase64Url(s) {
    const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        bytes[i] = bin.charCodeAt(i);
    return bytes;
}
// CryptoKey cache — importKey is an async round-trip and sign/verify sit on hot
// paths (every reservation, every ws upgrade). keyed by usage+secret; capped so
// a long-lived process signing for many rooms doesn't grow unboundedly (Map
// iteration order = insertion order, so evicting the first entry is FIFO).
const KEY_CACHE_MAX = 256;
const keyCache = new Map();
function hmacKey(secret, usage) {
    const cacheKey = `${usage}:${secret}`;
    const cached = keyCache.get(cacheKey);
    if (cached)
        return cached;
    const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
    if (keyCache.size >= KEY_CACHE_MAX) {
        const oldest = keyCache.keys().next().value;
        if (oldest !== undefined)
            keyCache.delete(oldest);
    }
    keyCache.set(cacheKey, key);
    key.catch(() => keyCache.delete(cacheKey));
    return key;
}
// static header — always the same, computed once
toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
/** verify a compact jwt string, returns the payload or null if invalid/expired */
async function jwtVerify(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;
    const [header, body, signature] = parts;
    let valid;
    try {
        const key = await hmacKey(secret, 'verify');
        // subtle.verify rather than a string compare — constant-time on the mac check
        valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(signature), encoder.encode(`${header}.${body}`));
    }
    catch {
        return null; // malformed base64url etc.
    }
    if (!valid)
        return null;
    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    }
    catch {
        return null;
    }
    // exp comes from the minting host's clock, so tolerate skew against ours
    if (typeof payload.exp === 'number' && Date.now() > payload.exp + JWT_CLOCK_LEEWAY_MS)
        return null;
    return payload;
}
/** tolerated clock skew between the host that mints a token and the one that verifies it */
const JWT_CLOCK_LEEWAY_MS = 30_000;

// structured json line logger
// emits ndjson to stdout/stderr, supports child loggers for scoped context
const LEVEL_VALUES = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
function resolveLevel() {
    const env = (typeof process !== 'undefined' && process.env?.GATHO_LOG_LEVEL) || '';
    const lower = env.toLowerCase();
    if (lower in LEVEL_VALUES)
        return lower;
    return 'info';
}
// serialize a value, handling Error instances that JSON.stringify turns into {}
function serializeValue(value) {
    if (value instanceof Error) {
        return { message: value.message, stack: value.stack };
    }
    return value;
}
function buildLine(level, msg, context, fields) {
    const entry = { ts: Date.now(), level, msg };
    for (const key in context) {
        entry[key] = serializeValue(context[key]);
    }
    if (fields) {
        for (const key in fields) {
            entry[key] = serializeValue(fields[key]);
        }
    }
    return JSON.stringify(entry);
}
function createLoggerInternal(minLevel, context) {
    function log(level, msg, fields) {
        if (LEVEL_VALUES[level] < minLevel)
            return;
        const line = buildLine(level, msg, context, fields);
        if (level === 'error') {
            process.stderr.write(`${line}\n`);
        }
        else {
            process.stdout.write(`${line}\n`);
        }
    }
    return {
        debug: (msg, fields) => log('debug', msg, fields),
        info: (msg, fields) => log('info', msg, fields),
        warn: (msg, fields) => log('warn', msg, fields),
        error: (msg, fields) => log('error', msg, fields),
        child(fields) {
            return createLoggerInternal(minLevel, { ...context, ...fields });
        },
    };
}
function createLogger(options) {
    const level = resolveLevel();
    return createLoggerInternal(LEVEL_VALUES[level], {});
}
// module-scope singleton — reads GATHO_LOG_LEVEL at import time
createLogger();

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

// room-side notify link (node runtimes): dial the parent server's notify
// channel over uds or tcp. rooms only ever send to the server — they never
// receive. so no frame reading is needed; we just wire up the send side.
//
// non-node runtimes don't use this module — they construct a Notifier from
// whatever pipe their host provides (e.g. a workerd service binding) or use
// the frame helpers in common/notify-protocol directly.
/** parse a notify target: `uds:<path>`, `tcp://host:port?token=...`, or a bare
 *  filesystem path (treated as a uds socket path). */
function parseNotifyTarget(uri) {
    if (uri.startsWith('uds:')) {
        return { kind: 'uds', path: uri.slice('uds:'.length) };
    }
    if (uri.startsWith('tcp://')) {
        const url = new URL(uri);
        const port = Number(url.port);
        if (!Number.isInteger(port) || port <= 0) {
            throw new Error(`notify: invalid tcp port in ${JSON.stringify(uri)}`);
        }
        return {
            kind: 'tcp',
            host: url.hostname,
            port,
            token: url.searchParams.get('token') ?? '',
        };
    }
    if (uri.includes('://')) {
        throw new Error(`notify: unsupported uri scheme in ${JSON.stringify(uri)} (expected uds: or tcp://)`);
    }
    // schemeless — a plain socket path
    return { kind: 'uds', path: uri };
}
/** dial a parsed notify target */
async function connectNotify(target, options) {
    const { createConnection } = await import('node:net');
    if (target.kind === 'uds') {
        return dial(() => createConnection({ path: target.path }), `uds ${target.path}`, null);
    }
    return dial(() => createConnection({ host: target.host, port: target.port }), `tcp ${target.host}:${target.port}`, target.token);
}
// shared dial-with-retry. for tcp, the auth token is written as the first
// frame immediately on connect — the server drops the connection if it's
// missing or wrong.
function dial(connect, label, token, options) {
    const maxRetries = 50;
    const retryDelay = 20;
    return new Promise((resolve, reject) => {
        let attempt = 0;
        const tryConnect = () => {
            const socket = connect();
            let connected = false;
            socket.on('connect', () => {
                connected = true;
                if (token !== null) {
                    socket.write(encodeRawFrame(new TextEncoder().encode(token)));
                }
                resolve({
                    send(msg) {
                        socket.write(encodeNotifyFrame(msg));
                    },
                    close() {
                        socket.destroy();
                    },
                });
            });
            socket.on('error', (error) => {
                if (connected)
                    return;
                socket.destroy();
                attempt++;
                if (attempt >= maxRetries) {
                    reject(new Error(`notify: failed to connect to ${label} after ${maxRetries} attempts: ${error.message}`));
                    return;
                }
                setTimeout(tryConnect, retryDelay);
            });
        };
        tryConnect();
    });
}

// ws transport — uses the `ws` npm package.
// works on node and bun. zero native addons.
//
// pub/sub is implemented manually since ws doesn't have built-in
// topic-based broadcast like uWebSockets.js.
function wsTransport(config) {
    return {
        async listen(handlers, listenConfig) {
            // `ws` and `http` load lazily, inside listen() — same pattern as
            // node:net in room/ipc.ts. a bundle for a runtime that supplies its
            // own transport (e.g. a workerd isolate) carries these as inert
            // dynamic imports and never executes them, so no shims are needed.
            const { createServer } = await import('http');
            const { WebSocketServer } = await import('ws');
            return new Promise((resolve, reject) => {
                const httpServer = createServer((_req, res) => {
                    // reject plain http requests — this server is ws-only
                    res.writeHead(426, { 'Content-Type': 'text/plain' });
                    res.end('upgrade required');
                });
                const wss = new WebSocketServer({
                    noServer: true,
                    maxPayload: config?.maxPayload ?? 1024 * 1024,
                    perMessageDeflate: config?.perMessageDeflate ?? false,
                });
                // connection state keyed by ws instance
                const connections = new Map();
                // reverse lookup: clientId -> ws
                const clientSockets = new Map();
                // topic subscriptions: topic -> set of ws instances
                const topics = new Map();
                // handle http upgrade — this is where auth happens.
                // upgrade() may be async (webcrypto jwt verify); the raw socket just
                // buffers until handleUpgrade consumes it.
                httpServer.on('upgrade', (req, socket, head) => {
                    const query = req.url?.split('?')[1] ?? '';
                    Promise.resolve(handlers.upgrade(query))
                        .then((result) => {
                        if (socket.destroyed)
                            return;
                        if (!result) {
                            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                            socket.destroy();
                            return;
                        }
                        completeUpgrade(req, socket, head, result);
                    })
                        .catch((err) => {
                        // NEVER swallow this. It is the only place a throw from upgrade() or
                        // from ws's own handleUpgrade can surface, and the client only ever
                        // sees an opaque 1006 (a bare 500 during an upgrade carries nothing a
                        // browser will show). Silent here means a room that logs `ready`,
                        // accepts connections, and rejects every one of them with no record
                        // on either side.
                        console.error('[gatho] websocket upgrade failed', err);
                        if (socket.destroyed)
                            return;
                        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                        socket.destroy();
                    });
                });
                function completeUpgrade(req, socket, head, result) {
                    const { clientId, reconnecting, versionMismatch } = result;
                    const joinData = result.joinData ?? {};
                    const tags = result.tags ?? {};
                    wss.handleUpgrade(req, socket, head, (ws) => {
                        // if reconnecting, clean up the old socket for this clientId
                        // (it may already be gone if the old connection closed cleanly)
                        const oldWs = clientSockets.get(clientId);
                        if (oldWs) {
                            const oldState = connections.get(oldWs);
                            if (oldState) {
                                for (const topic of oldState.topics) {
                                    const subs = topics.get(topic);
                                    if (subs) {
                                        subs.delete(oldWs);
                                        if (subs.size === 0) {
                                            topics.delete(topic);
                                        }
                                    }
                                }
                            }
                            connections.delete(oldWs);
                            // don't call oldWs.close() — it's already dead or will be
                        }
                        const state = {
                            clientId,
                            topics: new Set(),
                        };
                        connections.set(ws, state);
                        clientSockets.set(clientId, ws);
                        // build the WsSocket abstraction for start.ts
                        const wsSocket = {
                            send(data, isBinary) {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(data, { binary: isBinary });
                                }
                            },
                            close(code, reason) {
                                ws.close(code, reason);
                            },
                            subscribe(topic) {
                                state.topics.add(topic);
                                let subs = topics.get(topic);
                                if (!subs) {
                                    subs = new Set();
                                    topics.set(topic, subs);
                                }
                                subs.add(ws);
                            },
                            bufferedAmount() {
                                // ws exposes the outbound buffer directly (kernel + userland).
                                return ws.bufferedAmount;
                            },
                        };
                        if (reconnecting) {
                            handlers.reconnect(clientId, wsSocket, versionMismatch);
                        }
                        else {
                            handlers.open(clientId, wsSocket, joinData, tags, versionMismatch);
                        }
                        ws.on('message', (data, isBinary) => {
                            // generation guard: ignore frames from a socket that is no
                            // longer the current one for this clientId (a newer socket
                            // replaced it, e.g. a reconnect). without this a lingering
                            // stale socket could drive room logic against a live client.
                            if (clientSockets.get(clientId) !== ws)
                                return;
                            // normalize to arraybuffer — consistent with transport interface.
                            // we copy into a fresh ArrayBuffer to avoid SharedArrayBuffer issues
                            // with Buffer.buffer on some runtimes.
                            let ab;
                            if (data instanceof ArrayBuffer) {
                                ab = data;
                            }
                            else if (Buffer.isBuffer(data)) {
                                const copy = new Uint8Array(data.byteLength);
                                copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                                ab = copy.buffer;
                            }
                            else {
                                // Buffer[] (fragments) — concat then copy
                                const buf = Buffer.concat(data);
                                const copy = new Uint8Array(buf.byteLength);
                                copy.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
                                ab = copy.buffer;
                            }
                            handlers.message(clientId, ab, isBinary);
                        });
                        ws.on('close', (code) => {
                            // generation guard: is this socket still the current one
                            // for its clientId? a stale socket (replaced by a reconnect
                            // via completeUpgrade, which already dropped it from
                            // clientSockets) must self-clean but MUST NOT touch the new
                            // socket's mapping or drive room-side close logic.
                            const isCurrent = clientSockets.get(clientId) === ws;
                            // clean up this socket's own topic subscriptions
                            for (const topic of state.topics) {
                                const subs = topics.get(topic);
                                if (subs) {
                                    subs.delete(ws);
                                    if (subs.size === 0) {
                                        topics.delete(topic);
                                    }
                                }
                            }
                            connections.delete(ws);
                            if (!isCurrent)
                                return;
                            // only the current socket owns the reverse mapping and the
                            // room-side close — the normal single-socket close path.
                            clientSockets.delete(clientId);
                            handlers.close(clientId, code);
                        });
                    });
                }
                // listen on configured port, or 0 for os-assigned
                httpServer.listen(listenConfig?.port ?? 0, () => {
                    const addr = httpServer.address();
                    if (!addr || typeof addr === 'string') {
                        reject(new Error('failed to get server address'));
                        return;
                    }
                    const server = {
                        port: addr.port,
                        publish(topic, data, isBinary) {
                            const subs = topics.get(topic);
                            if (!subs)
                                return;
                            for (const ws of subs) {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(data, { binary: isBinary });
                                }
                            }
                        },
                        close() {
                            // close all ws connections
                            for (const ws of connections.keys()) {
                                ws.close(1001, 'server shutting down');
                            }
                            wss.close();
                            httpServer.close();
                        },
                    };
                    resolve(server);
                });
                httpServer.on('error', reject);
            });
        },
    };
}

const HEARTBEAT_INTERVAL_MS = 3000;
// --- runtime-neutral helpers ---
// the room engine runs in node, bun, deno, and workerd isolates. node-only
// surfaces (process env/metrics/signals, node:net) are feature-detected or
// lazily imported; entropy comes from webcrypto.
function readEnv(key) {
    return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}
function randomHex(byteLength) {
    const buf = new Uint8Array(byteLength);
    crypto.getRandomValues(buf);
    let hex = '';
    for (const b of buf)
        hex += b.toString(16).padStart(2, '0');
    return hex;
}
function safeCall(log, label, fn) {
    Promise.resolve()
        .then(fn)
        .catch((err) => {
        log.error(`${label} threw unexpectedly`, { err });
    });
}
// topic used for pub/sub broadcast
const BROADCAST_TOPIC = 'room';
// build the single stable Client handle for a tracked client. the handle
// carries the per-client verbs and closes over the tracked record, so id/data
// read live and send/allowReconnection/disconnect act on the current socket.
// `sendReliable` is injected so the handle can buffer-with-overflow-evict
// without this factory needing the room/onLeave context directly.
function makeClientHandle(state, tracked, verbs) {
    return {
        get id() {
            return tracked.id;
        },
        get data() {
            return tracked.data;
        },
        send(message, options) {
            // stale-handle verbs are silent no-ops.
            if (!tracked.alive || !state.alive)
                return;
            const framed = frameUserMessage(message);
            const reliable = options?.reliable !== false;
            if (tracked.socket) {
                tracked.socket.send(framed, true);
            }
            else if (reliable) {
                verbs.bufferForClient(tracked, framed);
            }
        },
        allowReconnection(windowMs) {
            if (!tracked.alive)
                return;
            // only meaningful when the client is disconnected
            if (tracked.socket)
                return;
            // set up the disconnect timer — when it fires, the client is evicted
            tracked.disconnectTimer = setTimeout(() => {
                tracked.disconnectTimer = null;
                verbs.evict(tracked);
            }, windowMs);
        },
        disconnect() {
            if (!tracked.alive)
                return;
            // server-initiated consented close — skip onDrop, straight to eviction
            verbs.evict(tracked);
        },
        get bufferedAmount() {
            // live socket buffer depth, 0 when disconnected/unobservable.
            if (!tracked.alive)
                return 0;
            return tracked.socket ? tracked.socket.bufferedAmount() : 0;
        },
    };
}
function createClientCollection(clients) {
    return {
        get(id) {
            const c = clients.get(id);
            if (!c)
                return undefined;
            return c.handle;
        },
        has(id) {
            return clients.has(id);
        },
        count() {
            return clients.size;
        },
        forEach(callback) {
            for (const [id, c] of clients) {
                callback(c.handle, id);
            }
        },
        ids() {
            return Array.from(clients.keys());
        },
        all() {
            return Array.from(clients.values()).map((c) => c.handle);
        },
        *[Symbol.iterator]() {
            // yield each client's stable handle — no allocation per step.
            for (const c of clients.values()) {
                yield c.handle;
            }
        },
    };
}
// default per-client reliable message buffer cap: 1mb
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576;
// permanently remove a client — cancel timers, invalidate session token,
// fire onLeave, notify driver. used on reconnect window expiry, buffer overflow,
// consented close, and disconnect without allowReconnection.
function evictClient(state, tracked, onLeave) {
    // idempotency: eviction can be triggered from multiple paths (timer, buffer
    // overflow, disconnect). mark dead once and bail on repeats so onLeave fires
    // exactly once and the handle's verbs become no-ops immediately.
    if (!tracked.alive)
        return;
    tracked.alive = false;
    if (tracked.disconnectTimer) {
        clearTimeout(tracked.disconnectTimer);
        tracked.disconnectTimer = null;
    }
    // invalidate session token
    state.sessionTokens.delete(tracked.sessionToken);
    // clear buffer
    tracked.reliableBuffer.length = 0;
    tracked.reliableBufferBytes = 0;
    // close socket if still open
    tracked.socket?.close(4000, 'evicted');
    // remove from clients map
    state.clients.delete(tracked.id);
    // fire onLeave with the client's stable handle
    if (onLeave) {
        safeCall(state.log, 'onLeave', () => onLeave(tracked.handle));
    }
    // notify driver
    state.ipc?.send({ type: 'client-disconnected', clientId: tracked.id });
}
function createRoom(state, maxBufferBytes, transport, port, callbacks) {
    const onLeave = callbacks.onLeave;
    // buffer a reliable message for a disconnected client.
    // if byte cap exceeded, evict the client.
    function bufferForClient(tracked, payload) {
        const byteSize = payload.byteLength;
        tracked.reliableBuffer.push({ payload, byteSize });
        tracked.reliableBufferBytes += byteSize;
        if (tracked.reliableBufferBytes > maxBufferBytes) {
            evictClient(state, tracked, onLeave);
        }
    }
    const verbs = {
        bufferForClient,
        evict: (tracked) => evictClient(state, tracked, onLeave),
    };
    const room = {
        get roomId() {
            return state.roomId;
        },
        get roomType() {
            return state.roomType;
        },
        get serverId() {
            return state.serverId;
        },
        broadcast(message, options) {
            // pre-start broadcast is always a programming error — the transport
            // isn't listening and no clients exist yet.
            if (!state.started) {
                throw new Error('gatho/room: room has not been started — call await room.start() before broadcasting');
            }
            // post-stop is a silent no-op.
            if (!state.alive)
                return;
            if (!state.server)
                return;
            const framed = frameUserMessage(message);
            const reliable = options?.reliable !== false;
            const except = options?.except;
            if (except === undefined) {
                // fast path: no exclusions — fan out via the transport's pub/sub in a
                // single publish, and buffer once per disconnected client for reconnect.
                state.server.publish(BROADCAST_TOPIC, framed, true);
                if (reliable) {
                    for (const tracked of state.clients.values()) {
                        if (!tracked.socket) {
                            bufferForClient(tracked, framed);
                        }
                    }
                }
                return;
            }
            // exclusion path: the pub/sub topic can't skip a member, so we abandon it
            // and iterate every tracked client, sending (or buffering) per socket while
            // skipping the excluded ids. an excluded client gets nothing — no live send
            // and no reliable buffering, so it never receives the message on reconnect.
            const excludedIds = new Set();
            if (Array.isArray(except)) {
                for (const c of except)
                    excludedIds.add(c.id);
            }
            else {
                excludedIds.add(except.id);
            }
            for (const tracked of state.clients.values()) {
                if (excludedIds.has(tracked.id))
                    continue;
                if (tracked.socket) {
                    tracked.socket.send(framed, true);
                }
                else if (reliable) {
                    bufferForClient(tracked, framed);
                }
            }
        },
        get clients() {
            return createClientCollection(state.clients);
        },
        start() {
            return startRoom(state, transport, port, verbs, callbacks);
        },
        stop() {
            return stopRoom(state, true, callbacks.onShutdown, onLeave);
        },
    };
    return room;
}
// --- heartbeat ---
function startHeartbeat(state) {
    if (!state.ipc)
        return;
    const ipc = state.ipc;
    state.heartbeatInterval = setInterval(() => {
        if (!state.alive)
            return;
        // collect clients with an active socket — these are the ground truth
        // for who is connected. clients in the reconnection window
        // (socket === null) have already been reported as disconnected.
        // include tags so the server's reconciler has the same context as the
        // fast path; otherwise the reconciler's connectClient call would
        // resurrect a partially-evicted driver record without tags.
        const clients = [];
        for (const [id, tracked] of state.clients) {
            if (tracked.socket !== null) {
                clients.push({ clientId: id, tags: tracked.tags });
            }
        }
        // process metrics are node/bun-only — omitted where the runtime can't
        // report them (e.g. workerd isolates). the wire schema marks them optional.
        let metrics;
        if (typeof process !== 'undefined' &&
            typeof process.memoryUsage === 'function' &&
            typeof process.cpuUsage === 'function') {
            const mem = process.memoryUsage();
            const cpu = process.cpuUsage();
            metrics = {
                memoryRss: mem.rss,
                memoryHeapUsed: mem.heapUsed,
                memoryHeapTotal: mem.heapTotal,
                cpuUser: cpu.user,
                cpuSystem: cpu.system,
            };
        }
        ipc.send({
            type: 'heartbeat',
            timestamp: Date.now(),
            metrics,
            clients,
        });
    }, HEARTBEAT_INTERVAL_MS);
}
// --- ws server / start ---
// bring the room online. this is the async half of the two-phase api,
// exposed as `room.start()`: dial the notify channel (managed mode), open the
// transport, signal ready, start heartbeats, install the SIGTERM hook.
// idempotency-guarded — a second call throws.
async function startRoom(state, transport, port, verbs, callbacks) {
    if (state.started) {
        throw new Error('gatho/room: room.start() has already been called');
    }
    state.started = true;
    // stop the "created but not started" warn — we made it.
    if (state.startWarnTimer) {
        clearTimeout(state.startWarnTimer);
        state.startWarnTimer = null;
    }
    // set up the notify link (managed mode). a Notifier object is used as-is
    // (in-process hosting); a uri string is dialed over uds/tcp — node:net is
    // loaded lazily inside the dialer, so non-node bundles that always pass a
    // Notifier object never execute a node import.
    const notifySource = state.notifySource;
    let ipc = null;
    if (typeof notifySource === 'string') {
        ipc = await connectNotify(parseNotifyTarget(notifySource));
    }
    else if (notifySource) {
        ipc = notifySource;
    }
    state.ipc = ipc;
    const options = callbacks;
    const handlers = {
        async upgrade(query) {
            const params = new URLSearchParams(query);
            // protocol version handshake — client and server gatho versions
            // must match exactly. missing or mismatched `gv` completes the
            // upgrade anyway (so the client gets a readable auth_error frame
            // rather than a raw 4xx, same rationale as the invalid-session
            // path below) then closes 4000 in open()/reconnect().
            const gvParam = params.get('gv');
            const clientVersion = gvParam === null ? 'none' : gvParam;
            if (clientVersion !== String(PROTOCOL_VERSION)) {
                const versionMismatch = `protocol version mismatch (client ${clientVersion}, server ${PROTOCOL_VERSION})`;
                // a reconnect carries a session param — thread the marker through
                // whichever handler the transport will call so the message lands.
                if (params.get('session')) {
                    return { clientId: crypto.randomUUID(), reconnecting: true, versionMismatch };
                }
                return { clientId: crypto.randomUUID(), versionMismatch };
            }
            // check for session token — reconnection attempt
            const sessionParam = params.get('session');
            if (sessionParam) {
                const clientId = state.sessionTokens.get(sessionParam);
                if (clientId) {
                    const tracked = state.clients.get(clientId);
                    // valid reconnection: client exists and is disconnected
                    if (tracked && tracked.socket === null) {
                        return { clientId, reconnecting: true };
                    }
                }
                // invalid/expired session — still upgrade the connection so
                // we can send __auth_error as a websocket message. if we
                // returned null here, the transport would send a raw 401 HTTP
                // response and the client couldn't distinguish "server down"
                // from "session expired", causing infinite retries.
                // the reconnect handler will see the client doesn't exist
                // and send __auth_error.
                return { clientId: sessionParam, reconnecting: true };
            }
            if (state.roomSecret) {
                // authenticated mode — verify jwt
                const token = params.get('token');
                if (!token)
                    return null;
                const payload = await jwtVerify(token, state.roomSecret);
                if (!payload)
                    return null;
                const clientId = payload.clientId;
                const roomId = payload.roomId;
                const joinData = payload.data ?? {};
                const tags = payload.tags ?? {};
                // verify the token is for this room
                if (roomId !== state.roomId)
                    return null;
                return { clientId, joinData, tags };
            }
            // dev mode — no jwt verification, generate identity
            return { clientId: crypto.randomUUID(), joinData: {}, tags: {} };
        },
        open(clientId, socket, joinData, tags, versionMismatch) {
            // reject a protocol-version-mismatched client with a readable error
            // before doing any auth or state work.
            if (versionMismatch) {
                socket.send(packProtocol({ type: 'auth_error', error: versionMismatch }), true);
                socket.close(CloseCode.CONSENTED, 'protocol version mismatch');
                return;
            }
            // one-shot seats: a reservation jwt is redeemed exactly once. if this
            // clientId is already tracked we reject rather than overwrite. two cases:
            //  - live socket: a duplicate connection with the same seat token —
            //    reject so the existing session is never disturbed.
            //  - null socket (reconnection window): the seat is held for a client
            //    that dropped. resumption MUST go through the session-token reconnect
            //    path — the jwt was already spent on the first open(), so a fresh jwt
            //    open() here would silently reset session state. reject it too.
            // rejecting before onAuth also means the duplicate never overwrites the
            // sessionTokens entry, so the old session token can no longer leak.
            if (state.clients.has(clientId)) {
                socket.send(packProtocol({ type: 'auth_error', error: 'seat already in use' }), true);
                socket.close(4000, 'seat already in use');
                return;
            }
            (async () => {
                let result;
                try {
                    result = await Promise.resolve(options.onAuth ? options.onAuth(joinData) : { ok: true, data: {} });
                }
                catch (err) {
                    // onAuth threw — bug in user code
                    state.log.error('onAuth threw unexpectedly', { clientId, err });
                    socket.send(packProtocol({ type: 'auth_error', error: 'internal error' }), true);
                    socket.close(1011, 'internal error');
                    return;
                }
                if (!result.ok) {
                    socket.send(packProtocol({ type: 'auth_error', error: String(result.error) }), true);
                    socket.close(4000, 'auth rejected');
                    return;
                }
                // generate session token
                const sessionToken = randomHex(16);
                state.sessionTokens.set(sessionToken, clientId);
                // track client, building its single stable handle now — reused
                // across every callback and room.clients access for its lifetime.
                const tracked = {
                    id: clientId,
                    data: result.data,
                    socket,
                    sessionToken,
                    reliableBuffer: [],
                    reliableBufferBytes: 0,
                    disconnectTimer: null,
                    tags,
                    handle: undefined,
                    alive: true,
                };
                tracked.handle = makeClientHandle(state, tracked, verbs);
                state.clients.set(clientId, tracked);
                // subscribe to broadcasts only now that auth has passed — a
                // rejected client must never be subscribed, and broadcasts sent
                // during a slow async onAuth must not reach an unauthenticated socket.
                socket.subscribe(BROADCAST_TOPIC);
                // send session token to client
                socket.send(packProtocol({ type: 'session', token: sessionToken, clientId }), true);
                // notify server for driver bookkeeping (managed mode only).
                // forward roomId + tags so driver.connectClient can perform a
                // full upsert — covers the case where the driver's client
                // record was evicted between reserveClient and now.
                state.ipc?.send({ type: 'client-connected', clientId, roomId: state.roomId, tags });
                // run onJoin with the client's stable handle
                if (options.onJoin) {
                    await Promise.resolve(options.onJoin(tracked.handle));
                }
            })().catch((err) => {
                state.log.error('onJoin threw unexpectedly', { clientId, err });
            });
        },
        message(clientId, data, _isBinary) {
            const tracked = state.clients.get(clientId);
            if (!tracked?.socket)
                return;
            const frame = unpackFrame(data);
            if (frame.frame === 'protocol') {
                if (frame.message.type === 'leave') {
                    tracked.socket.close(4000, 'consented leave');
                }
                return;
            }
            if (options.onMessage) {
                if (frame.frame === 'user_text') {
                    safeCall(state.log, 'onMessage', () => options.onMessage(tracked.handle, frame.text));
                }
                else {
                    safeCall(state.log, 'onMessage', () => options.onMessage(tracked.handle, frame.data));
                }
            }
        },
        reconnect(clientId, socket, versionMismatch) {
            // reject a protocol-version-mismatched client with a readable error
            // before touching reconnection state.
            if (versionMismatch) {
                socket.send(packProtocol({ type: 'auth_error', error: versionMismatch }), true);
                socket.close(CloseCode.CONSENTED, 'protocol version mismatch');
                return;
            }
            const tracked = state.clients.get(clientId);
            if (!tracked || tracked.socket !== null) {
                // not a valid reconnection target — close
                socket.send(packProtocol({ type: 'auth_error', error: 'invalid session' }), true);
                socket.close(4000, 'invalid session');
                return;
            }
            // cancel the disconnect timer
            if (tracked.disconnectTimer) {
                clearTimeout(tracked.disconnectTimer);
                tracked.disconnectTimer = null;
            }
            // swap socket
            tracked.socket = socket;
            // subscribe new socket to broadcast topic
            socket.subscribe(BROADCAST_TOPIC);
            // invalidate old session token, generate new one
            state.sessionTokens.delete(tracked.sessionToken);
            const newToken = randomHex(16);
            tracked.sessionToken = newToken;
            state.sessionTokens.set(newToken, clientId);
            // flush reliable buffer to client (FIFO)
            for (const buffered of tracked.reliableBuffer) {
                socket.send(buffered.payload, true);
            }
            tracked.reliableBuffer.length = 0;
            tracked.reliableBufferBytes = 0;
            // send new session token — this is the "reconnection handshake complete" signal
            socket.send(packProtocol({ type: 'session', token: newToken, clientId }), true);
            // fire onReconnect
            if (options.onReconnect) {
                safeCall(state.log, 'onReconnect', () => options.onReconnect(tracked.handle));
            }
            // notify driver: client is connected again. forward roomId + the
            // tags we cached at original open() — same upsert path as fast.
            state.ipc?.send({ type: 'client-connected', clientId, roomId: state.roomId, tags: tracked.tags });
        },
        close(clientId, code) {
            const tracked = state.clients.get(clientId);
            if (!tracked)
                return;
            const onLeave = options.onLeave;
            // consented close (4000) or no onDrop defined — permanent leave
            if (code === 4000 || !options.onDrop) {
                evictClient(state, tracked, onLeave);
                return;
            }
            // non-consented disconnect — mark as disconnected, fire onDrop
            tracked.socket = null;
            const onDrop = options.onDrop;
            (async () => {
                // fire onDrop — room code may call client.allowReconnection inside
                await Promise.resolve(onDrop(tracked.handle, code));
                // if allowReconnection was NOT called (no timer set), evict immediately.
                // guard against a client that reconnected while onDrop awaited: require
                //  - still in the map (not already evicted by something else), and
                //  - socket still null (a reconnect swaps in a live socket — evicting
                //    then would kill a freshly reconnected client). allowReconnection
                //    already no-ops post-reconnect, so this branch is the guaranteed
                //    outcome of the race without the socket check.
                if (!tracked.disconnectTimer && tracked.socket === null && state.clients.has(tracked.id)) {
                    evictClient(state, tracked, onLeave);
                }
            })().catch((err) => {
                state.log.error('onDrop threw unexpectedly', { clientId, err });
            });
        },
    };
    const server = await transport.listen(handlers, { port });
    state.server = server;
    // managed mode: start heartbeats and signal ready to the parent server.
    if (ipc) {
        startHeartbeat(state);
        ipc.send({ type: 'ready', port: server.port });
    }
    // signal handling belongs to whoever owns the process — install only where
    // there is one (node/bun/deno; workerd isolates have no signals).
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
        const sigtermHandler = () => {
            stopRoom(state, false, callbacks.onShutdown, callbacks.onLeave).catch((err) => {
                state.log.error('error during shutdown', { err });
            });
        };
        state.sigtermHandler = sigtermHandler;
        process.on('SIGTERM', sigtermHandler);
    }
}
async function stopRoom(state, selfInitiated, onShutdown, onLeave) {
    if (!state.alive)
        return;
    state.alive = false;
    // clear the created-but-not-started warn if stop() somehow runs before start().
    if (state.startWarnTimer) {
        clearTimeout(state.startWarnTimer);
        state.startWarnTimer = null;
    }
    // remove SIGTERM handler to prevent listener leak
    if (state.sigtermHandler) {
        process.removeListener('SIGTERM', state.sigtermHandler);
        state.sigtermHandler = null;
    }
    if (state.heartbeatInterval) {
        clearInterval(state.heartbeatInterval);
        state.heartbeatInterval = null;
    }
    if (onShutdown) {
        await Promise.resolve(onShutdown());
    }
    // snapshot all tracked clients and clear the map before closing sockets.
    // clearing first prevents the transport's close handler from running
    // eviction logic (it bails early when the client isn't in the map).
    const trackedClients = Array.from(state.clients.values());
    state.clients.clear();
    state.sessionTokens.clear();
    // fire onLeave for each client and clean up
    for (const tracked of trackedClients) {
        // mark the handle dead so any verbs called from onLeave are no-ops.
        tracked.alive = false;
        // cancel any pending disconnect timer
        if (tracked.disconnectTimer) {
            clearTimeout(tracked.disconnectTimer);
            tracked.disconnectTimer = null;
        }
        // clear reliable buffer
        tracked.reliableBuffer.length = 0;
        tracked.reliableBufferBytes = 0;
        // fire onLeave with the client's stable handle
        if (onLeave) {
            safeCall(state.log, 'onLeave', () => onLeave(tracked.handle));
        }
        // notify driver
        state.ipc?.send({ type: 'client-disconnected', clientId: tracked.id });
        // close socket
        tracked.socket?.close(1001, 'room shutting down');
    }
    // close transport server
    if (state.server) {
        state.server.close();
        state.server = null;
    }
    // tell server we stopped intentionally so it can remove from desired state
    if (selfInitiated) {
        state.ipc?.send({ type: 'stopped' });
    }
    state.ipc?.close();
}
// env vars that indicate a managed server context
const MANAGED_ENV_KEYS = [
    'GATHO_NOTIFY_SOCKET',
    'GATHO_ROOM_ID',
    'GATHO_ROOM_TYPE',
    'GATHO_ROOM_SECRET',
    'GATHO_SERVER_ID',
];
// warn if a created room hasn't been started within this window — standalone
// dev insurance. managed mode's server-side startup timeout already covers the
// forgot-to-start case there.
const START_WARN_MS = 5000;
/** build a room (synchronous). resolves managed context (env vars / `options.server`),
 *  builds the RoomState and the {@link Room} handle, and stores the lifecycle
 *  callbacks. does NOT open the transport or dial the notify channel — call
 *  `await room.start()` for that.
 *
 *  design: the two-phase split puts everything SYNCHRONOUS here (env reads, the
 *  fail-closed standalone check, identity assignment) so `room.roomId` etc. are
 *  readable immediately and the fail-closed throw is a plain synchronous throw.
 *  the only ASYNC work (notify dial, transport listen, ready signal, heartbeat,
 *  SIGTERM hook) lives in `room.start()`, whose failure mode is a rejected
 *  promise the caller awaits. */
function create(options) {
    // --- resolve managed context (synchronous) ---
    const presentEnvKeys = MANAGED_ENV_KEYS.filter((k) => readEnv(k) !== undefined);
    const hasServerOption = options.server !== undefined;
    let roomId;
    let roomType;
    let notifySource;
    let roomSecret;
    let serverId;
    if (options.standalone === true) {
        // pure standalone — ignore all managed config
        if (hasServerOption || presentEnvKeys.length > 0) {
            const bits = [
                hasServerOption ? 'options.server' : null,
                presentEnvKeys.length > 0 ? `env vars (${presentEnvKeys.join(', ')})` : null,
            ]
                .filter(Boolean)
                .join(' and ');
            createLogger().warn(`gatho/room: standalone: true is set, ignoring managed context from ${bits}`);
        }
        roomId = crypto.randomUUID();
        roomType = 'room';
        notifySource = undefined;
        roomSecret = null;
        serverId = undefined;
    }
    else {
        const server = options.server;
        roomId = server?.roomId ?? readEnv('GATHO_ROOM_ID') ?? crypto.randomUUID();
        roomType = server?.roomType ?? readEnv('GATHO_ROOM_TYPE') ?? 'room';
        roomSecret = server?.roomSecret ?? readEnv('GATHO_ROOM_SECRET') ?? null;
        serverId = server?.serverId ?? readEnv('GATHO_SERVER_ID');
        // notify channel resolution: explicit option → GATHO_NOTIFY_SOCKET
        // (a `uds:`/`tcp://` uri, or a bare uds socket path)
        notifySource = server?.notify ?? readEnv('GATHO_NOTIFY_SOCKET');
        // fail closed: require managed context OR explicit standalone opt-in.
        // this prevents accidentally running a room with no auth in production.
        if (!notifySource && !roomSecret) {
            throw new Error('gatho/room create(): no managed server context detected ' +
                '(no GATHO_NOTIFY_SOCKET / GATHO_ROOM_SECRET env vars, and no options.server.notify / roomSecret). ' +
                'If running this room directly for local dev or tests, pass `standalone: true`. ' +
                'Otherwise ensure the gatho server spawned this process so GATHO_* env vars are set.');
        }
    }
    const log = createLogger().child({ roomId, roomType });
    const state = {
        roomId,
        roomType,
        serverId,
        roomSecret,
        clients: new Map(),
        sessionTokens: new Map(),
        notifySource,
        ipc: null,
        heartbeatInterval: null,
        started: false,
        alive: true,
        server: null,
        sigtermHandler: null,
        startWarnTimer: null,
        log,
    };
    const transport = options.transport ?? wsTransport();
    const room = createRoom(state, options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES, transport, options.port, {
        onAuth: options.onAuth,
        onJoin: options.onJoin,
        onMessage: options.onMessage,
        onLeave: options.onLeave,
        onDrop: options.onDrop,
        onReconnect: options.onReconnect,
        onShutdown: options.onShutdown,
    });
    // dev insurance: warn if start() is never called. cleared by start()/stop().
    // unref'd so it never keeps the process alive on its own.
    const warnTimer = setTimeout(() => {
        state.startWarnTimer = null;
        if (!state.started) {
            log.warn('gatho/room: room created but start() not called within 5s — did you forget `await room.start()`?');
        }
    }, START_WARN_MS);
    if (typeof warnTimer.unref === 'function')
        warnTimer.unref();
    state.startWarnTimer = warnTimer;
    return room;
}

export { CloseCode, create, createFrameParser, encodeNotifyFrame, encodeRawFrame, notifyCodec, wsTransport };
//# sourceMappingURL=room.js.map
