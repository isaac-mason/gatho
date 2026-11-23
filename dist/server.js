import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID, randomBytes as randomBytes$1 } from 'crypto';
import * as http from 'http';
import { spawn } from 'node:child_process';

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
const log = createLogger();

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
const textEncoder = new TextEncoder();
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
        const { written } = textEncoder.encodeInto(s, this.buf.subarray(this.pos, this.pos + byteLength));
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
const writer = new Writer();
const reader = new Reader();
function writeTags(tags) {
    const countAt = writer.reserveCount();
    let count = 0;
    for (const key in tags) {
        writer.str(key);
        writer.str(tags[key]);
        count++;
    }
    writer.patchCount(countAt, count);
}
function readTags() {
    const count = reader.count(MIN_RECORD_ENTRY_BYTES);
    const tags = {};
    for (let i = 0; i < count; i++) {
        const key = reader.str();
        const value = reader.str();
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
    writer.u8(NOTIFY_FORMAT);
    switch (msg.type) {
        case 'ready':
            writer.u8(TAG_READY);
            writer.u16(msg.port);
            break;
        case 'heartbeat': {
            writer.u8(TAG_HEARTBEAT);
            writer.f64(msg.timestamp);
            const metrics = msg.metrics;
            if (metrics === undefined) {
                writer.u8(0);
            }
            else {
                writer.u8(1);
                writer.f64(metrics.memoryRss);
                writer.f64(metrics.memoryHeapUsed);
                writer.f64(metrics.memoryHeapTotal);
                writer.f64(metrics.cpuUser);
                writer.f64(metrics.cpuSystem);
            }
            const clients = msg.clients;
            writer.varint(clients.length);
            for (let i = 0; i < clients.length; i++) {
                const client = clients[i];
                writer.str(client.clientId);
                writeTags(client.tags);
            }
            break;
        }
        case 'client-connected':
            writer.u8(TAG_CLIENT_CONNECTED);
            writer.str(msg.clientId);
            writer.str(msg.roomId);
            writeTags(msg.tags);
            break;
        case 'client-disconnected':
            writer.u8(TAG_CLIENT_DISCONNECTED);
            writer.str(msg.clientId);
            break;
        case 'error':
            writer.u8(TAG_ERROR);
            writer.str(msg.message);
            break;
        case 'stopped':
            writer.u8(TAG_STOPPED);
            break;
        default:
            throw new Error(`unknown notify message type: ${String(msg.type)}`);
    }
}
function readMessage() {
    const format = reader.u8();
    if (format !== NOTIFY_FORMAT) {
        throw new Error(`notify format mismatch (got 0x${format.toString(16).padStart(2, '0')}, expected 0x${NOTIFY_FORMAT.toString(16)}), is the room built from a different gatho version?`);
    }
    const tag = reader.u8();
    switch (tag) {
        case TAG_READY:
            return { type: 'ready', port: reader.u16() };
        case TAG_HEARTBEAT: {
            const timestamp = reader.f64();
            const hasMetrics = reader.u8();
            let metrics;
            if (hasMetrics === 1) {
                const memoryRss = reader.f64();
                const memoryHeapUsed = reader.f64();
                const memoryHeapTotal = reader.f64();
                const cpuUser = reader.f64();
                const cpuSystem = reader.f64();
                metrics = { memoryRss, memoryHeapUsed, memoryHeapTotal, cpuUser, cpuSystem };
            }
            else if (hasMetrics !== 0) {
                throw new Error(`invalid heartbeat metrics flag: ${hasMetrics}`);
            }
            const count = reader.count(MIN_HEARTBEAT_CLIENT_BYTES);
            const clients = [];
            for (let i = 0; i < count; i++) {
                const clientId = reader.str();
                const tags = readTags();
                clients.push({ clientId, tags });
            }
            return { type: 'heartbeat', timestamp, metrics, clients };
        }
        case TAG_CLIENT_CONNECTED: {
            const clientId = reader.str();
            const roomId = reader.str();
            const tags = readTags();
            return { type: 'client-connected', clientId, roomId, tags };
        }
        case TAG_CLIENT_DISCONNECTED:
            return { type: 'client-disconnected', clientId: reader.str() };
        case TAG_ERROR:
            return { type: 'error', message: reader.str() };
        case TAG_STOPPED:
            return { type: 'stopped' };
        default:
            throw new Error(`unknown notify message tag: 0x${tag.toString(16).padStart(2, '0')}`);
    }
}
/** encoder and decoder for the notify payload (no length framing) */
const notifyCodec = {
    pack(msg) {
        writer.begin();
        writeMessage(msg);
        return writer.finish();
    },
    /** decode one payload. throws an Error on anything malformed. */
    unpack(payload) {
        reader.reset(payload, 0);
        try {
            const msg = readMessage();
            reader.finish();
            return msg;
        }
        finally {
            reader.release();
        }
    },
};
// --- framing ---
// header: 4 bytes uint32 BE length
const HEADER_SIZE = 4;
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
/** streaming notify-message reader built on the frame parser.
 *  malformed frames are dropped via `onError` rather than thrown — callers are
 *  socket 'data' handlers which must not throw. */
function createFrameReader(onMessage, onError) {
    return createFrameParser((payload) => {
        try {
            onMessage(notifyCodec.unpack(payload));
        }
        catch (err) {
            onError?.(err);
        }
    });
}

// notify channel helpers — for use inside `runner()` spawn functions.
//
// a channel helper connects a room's Notifier to the server's message handler
// (`ctx.onMessage`) across a process boundary: it listens on some pipe, decodes
// the room's frames, and feeds them to `ctx.onMessage`. helpers resolve once
// they are LISTENING (not once the room connects) so the runner can grab
// `chan.env` before launching the room.
/**
 * Build the per-room UDS socket path: `socketDir/<roomId>/sock`.
 *
 * The per-room subdirectory (rather than a flat `socketDir/<roomId>.sock`) is what
 * lets a container runner mount each room only its own socket dir, isolating the
 * notify channel from sibling rooms. `roomId` becomes a path segment, so reject
 * anything that could escape `socketDir`.
 *
 * The socket filename is kept to `sock` (not e.g. `room.sock`) on purpose: unix
 * socket paths have a hard length limit (~104 bytes on macOS) and the per-room
 * subdir already costs the `roomId` segment. `<roomId>/sock` is the same length as
 * the old flat `<roomId>.sock`, so we don't regress paths that used to fit. Don't
 * lengthen this filename without re-checking that limit on the longest socketDir.
 */
function roomSocketPath(socketDir, roomId) {
    if (roomId.includes('/') || roomId.includes('\\') || roomId === '.' || roomId === '..') {
        throw new Error(`invalid roomId for socket path: ${JSON.stringify(roomId)}`);
    }
    return join(socketDir, roomId, 'sock');
}
const DEFAULT_SOCKET_DIR = () => join(tmpdir(), 'gatho-ipc');
function channelListener(label, roomId, handleSocket) {
    let active = null;
    let closed = false;
    const server = createServer((socket) => {
        if (closed) {
            socket.destroy();
            return;
        }
        // absorb socket errors — a broken pipe or reset must not become an
        // uncaught EventEmitter error.
        socket.on('error', (err) => {
            log.error(`${label}: socket error`, { roomId, err });
        });
        socket.on('close', () => {
            if (active === socket)
                active = null;
        });
        handleSocket(socket, (s) => {
            if (active !== null || closed)
                return false;
            active = s;
            return true;
        });
    });
    return {
        server,
        close() {
            if (closed)
                return;
            closed = true;
            active?.destroy();
            server.close();
        },
    };
}
/**
 * uds notify channel: creates a unix domain socket at `socketDir/<roomId>/sock`,
 * listens for the room to dial back, and feeds decoded frames to `ctx.onMessage`.
 *
 * resolves once listening — spawn the room after this so `GATHO_NOTIFY_SOCKET`
 * (in `chan.env`) points at a live socket.
 *
 * socket close needs no handling here — a room that hangs up either already sent
 * `stopped` (self-stop) or is about to exit (crash), both of which reach the
 * server through other paths (`stopped` message / runner `ctx.stopped`), with
 * the heartbeat stall sweep as the backstop. a room may redial after a drop.
 */
function uds(ctx, options) {
    const socketDir = options?.socketDir ?? DEFAULT_SOCKET_DIR();
    const socketPath = roomSocketPath(socketDir, ctx.roomId);
    return new Promise((resolve, reject) => {
        const dir = dirname(socketPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        // clean up stale socket file if present
        try {
            unlinkSync(socketPath);
        }
        catch {
            // not there, fine
        }
        const core = channelListener('uds notify', ctx.roomId, (socket, adopt) => {
            if (!adopt(socket)) {
                socket.destroy();
                return;
            }
            const push = createFrameReader((msg) => ctx.onMessage(msg), (err) => {
                log.error('uds notify: malformed frame dropped', { socketPath, err });
            });
            socket.on('data', (chunk) => push(chunk));
        });
        function close() {
            core.close();
            try {
                unlinkSync(socketPath);
            }
            catch {
                // already gone
            }
            try {
                rmdirSync(dirname(socketPath));
            }
            catch {
                // non-empty or already gone — fine
            }
        }
        core.server.on('error', (error) => {
            if (!core.server.listening) {
                reject(error);
                return;
            }
            log.error('uds notify: server error', { socketPath, err: error });
        });
        core.server.listen(socketPath, () => {
            resolve({
                socketPath,
                socketDir: dirname(socketPath),
                env: {
                    GATHO_NOTIFY_SOCKET: `uds:${socketPath}`,
                },
                close,
            });
        });
    });
}
/**
 * tcp notify channel: loopback listener carrying the same length-prefixed
 * frames as uds. where uds gets isolation from filesystem permissions,
 * tcp gets it from a per-room bearer token: the room must send the token as its
 * first frame or the connection is dropped.
 *
 * for rooms that can't reach a unix socket — containers without a mount,
 * remote-ish sandboxes, workerd isolates (via `connect()`).
 *
 * resolves once listening — spawn the room after this so the uri in `chan.env`
 * points at a live listener.
 */
function tcp(ctx, options) {
    const bindHost = options?.host ?? '127.0.0.1';
    const advertisedHost = options?.advertisedHost ?? bindHost;
    const token = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
        const core = channelListener('tcp notify', ctx.roomId, (socket, adopt) => {
            // token gate: first frame must be the utf-8 token. only a socket that
            // presents it (and wins the active slot) is kept.
            let authed = false;
            const parser = createFrameParser((payload) => {
                if (!authed) {
                    const presented = new TextDecoder().decode(payload);
                    if (presented !== token || !adopt(socket)) {
                        log.warn('tcp notify: rejected connection (bad token or already connected)', {
                            roomId: ctx.roomId,
                        });
                        socket.destroy();
                        return;
                    }
                    authed = true;
                    return;
                }
                try {
                    ctx.onMessage(notifyCodec.unpack(payload));
                }
                catch (err) {
                    log.error('tcp notify: malformed frame dropped', { roomId: ctx.roomId, err });
                }
            });
            socket.on('data', (chunk) => parser(chunk));
        });
        core.server.on('error', (error) => {
            if (!core.server.listening) {
                reject(error);
                return;
            }
            log.error('tcp notify: server error', { roomId: ctx.roomId, err: error });
        });
        core.server.listen(0, bindHost, () => {
            const addr = core.server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('tcp notify: failed to get listener address'));
                return;
            }
            resolve({
                port: addr.port,
                token,
                env: {
                    GATHO_NOTIFY_SOCKET: `tcp://${advertisedHost}:${addr.port}?token=${token}`,
                },
                close: core.close,
            });
        });
    });
}
/**
 * direct notify channel: no wire at all. for rooms hosted in the same process
 * as the server — the room is handed (a thin gate over) the server core's own
 * notifier. synchronous, unlike the wire channels: there is nothing to bind.
 */
function direct(ctx) {
    let closed = false;
    return {
        notifier: {
            send(msg) {
                if (!closed)
                    ctx.onMessage(msg);
            },
            close() {
                closed = true;
            },
        },
        close() {
            closed = true;
        },
    };
}
/** notify channel helpers, composed inside `runner()` spawn functions. */
const notify = {
    uds,
    tcp,
    direct,
};

/**
 * ergonomic factory for creating a RoomRunner.
 *
 * the provided function receives a spawn context carrying two sinks into the server core —
 * `ctx.onMessage` (room→server notify messages) and `ctx.stopped` (the room exited) — sets up
 * the room, and returns a destructor. the destructor is called by the server when it wants the
 * room to stop. `ctx.stopped()` should be called when the room has exited, for any reason.
 *
 * how notify messages get from the room into `ctx.onMessage` is this function's business:
 * compose a channel helper (`notify.uds(ctx)`, `notify.tcp(ctx)`, `notify.direct(ctx)`) or
 * send on it directly to synthesize messages on the room's behalf.
 *
 * supports both sync and async spawn/destructor — async is useful for runners that need to make
 * API calls (e.g. ECS RunTask, docker create) during setup or teardown. if an async spawn
 * rejects, the failure is surfaced as a synthesized `{ type: 'error' }` notify message followed
 * by `stopped(null)`.
 */
function runner(fn) {
    return {
        spawn(ctx) {
            // track destructor — may resolve later if spawn is async
            let destructor = null;
            let queuedKill = false;
            const runnerCtx = {
                ...ctx,
                env: {
                    GATHO_ROOM_ID: ctx.roomId,
                    GATHO_ROOM_TYPE: ctx.roomType,
                    GATHO_SERVER_ID: ctx.serverId,
                    GATHO_ROOM_SECRET: ctx.roomSecret,
                },
            };
            const result = fn(runnerCtx);
            if (result instanceof Promise) {
                result
                    .then((d) => {
                    destructor = d;
                    if (queuedKill)
                        void d();
                })
                    .catch((err) => {
                    // async spawn failed — the room never started. surface the
                    // cause and report the exit so the server can reschedule.
                    ctx.onMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
                    ctx.stopped(null);
                });
            }
            else {
                destructor = result;
            }
            return {
                kill() {
                    if (destructor) {
                        void destructor();
                    }
                    else {
                        queuedKill = true;
                    }
                },
            };
        },
    };
}

/** race a promise against a timeout. rejects with `${label} timeout` if it doesn't
 *  settle in time. `onTimeout` (if given) fires synchronously when the timeout wins
 *  the race — the underlying promise is not cancelled, so this is the hook to mark
 *  its result stale. */
async function withTimeout(p, ms, label, onTimeout) {
    let timer;
    try {
        return await Promise.race([
            p,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    onTimeout?.();
                    reject(new Error(`${label} timeout`));
                }, ms);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * schedule async work on a self-pacing cadence.
 *
 * the first tick runs eagerly and is awaited before this function returns; the
 * caller can rely on `run` having executed once (success or caught error) by
 * the time the resulting Punctuator handle is in hand. each subsequent tick is
 * scheduled `intervalMs` after the previous one's start (or immediately if the
 * previous run exceeded the interval). avoids both pending-promise pile-up
 * (no overlap by construction) and the "skip a full interval" gap that
 * setInterval + skip-on-overlap produces when a run runs long.
 *
 * `run` receives an `isCurrent()` predicate. it returns true while this tick is
 * still the live one and becomes false the instant the tick times out (the next
 * tick may then start) or the punctuator is stopped. withTimeout rejects a slow
 * run but cannot cancel the underlying promise — it keeps executing. a run that
 * outlives its timeout MUST check isCurrent() before any destructive action so
 * it doesn't act on conclusions drawn from now-stale state while a fresh tick is
 * already reconciling.
 */
async function punctuate(label, run, opts) {
    const log$1 = opts.logger ?? log;
    let stopped = false;
    let timer;
    // monotonically increasing tick epoch. a run captures its epoch on entry;
    // isCurrent() reads true only while the live epoch still matches. the epoch
    // advances the moment a run stops being authoritative — on timeout, on
    // stop, or when the run completes and the next tick is scheduled — so an
    // orphaned run (rejected by withTimeout but still executing) sees false.
    let epoch = 0;
    function stop() {
        stopped = true;
        epoch++;
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    }
    async function tick() {
        if (stopped)
            return;
        const startedAt = Date.now();
        const myEpoch = epoch;
        const isCurrent = () => !stopped && epoch === myEpoch;
        try {
            // onTimeout advances the epoch so the still-executing run's
            // isCurrent() flips to false the instant the tick is abandoned.
            await withTimeout(run(isCurrent), opts.timeoutMs, label, () => {
                if (epoch === myEpoch)
                    epoch++;
            });
        }
        catch (err) {
            log$1.error(`${label} error`, { err });
        }
        if (stopped)
            return;
        const elapsed = Date.now() - startedAt;
        const delay = Math.max(0, opts.intervalMs - elapsed);
        // advance the epoch (idempotent if the timeout already did) so the
        // just-finished run — and any orphaned timed-out run — reads not-current,
        // then schedule the next tick with its own fresh epoch.
        if (epoch === myEpoch)
            epoch++;
        timer = setTimeout(tick, delay);
    }
    await tick();
    return { stop };
}

// start - main entry point for gatho server
// uses reconciliation loop for room spawning.
// rooms run their own websocket servers — clients connect directly.
// this process is control-plane only: health checks, reconciliation, leader election.
//
// the server core does NOT own the notify channel — the runner does. spawn hands
// the runner its message handler and exit sink (ctx.onMessage, ctx.stopped); how
// the room's messages reach them (uds frames, tcp, in-memory) is the runner's business.
// messages flow one direction: room → server.
/* constants */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const LEADER_LOOP_INTERVAL_MS = 10_000;
const LEADER_LOOP_TIMEOUT_MS = 5_000;
const HEARTBEAT_TICK_TIMEOUT_MS = 5_000;
// consecutive missed heartbeat intervals before the outage is logged as an error
const HEARTBEAT_OUTAGE_LOG_AFTER_INTERVALS = 3;
// how long a spawn attempt is remembered after its room leaves the desired set
const ATTEMPT_RETENTION_MS = 5 * 60_000;
/** default for CreateServerOptions.roomStallTimeoutMs */
const DEFAULT_ROOM_STALL_TIMEOUT_MS = 10_000;
/** default for CreateServerOptions.roomStartupTimeoutMs */
const DEFAULT_ROOM_STARTUP_TIMEOUT_MS = 30_000;
function cleanupRoom(s, roomId, reason) {
    const proc = s.processes.get(roomId);
    if (!proc)
        return;
    s.processes.delete(roomId);
    s.lastHeartbeats.delete(roomId);
    proc.markExited();
    log.info('room cleaned up', { roomId, reason });
    switch (reason) {
        case 'self-stopped':
            // room decided to stop — remove from desired state
            s.driver.unregisterRoom(roomId).catch((err) => {
                log.error('failed to unregister room after self-stop', { roomId, err });
            });
            break;
        case 'heartbeat-timeout':
            // process stalled — report failure so driver can reschedule
            s.driver.roomFailure(roomId, 'process stalled (heartbeat timeout)').catch((err) => {
                log.error('failed to report room failure', { roomId, err });
            });
            break;
        case 'process-exited':
            if (s.killedRoomIds.has(roomId)) {
                // expected — server initiated the kill, reconciler handles
                s.killedRoomIds.delete(roomId);
            }
            else {
                // unexpected crash — report to driver so it's removed from desired state
                s.driver.roomFailure(roomId, `unexpected ${reason}`).catch((err) => {
                    log.error('failed to report room failure', { roomId, err });
                });
            }
            break;
    }
}
/* ipc message handling */
// reconcile driver client state against the room's ground truth (from heartbeat).
// the room's client list is authoritative — if a fast-path connect/disconnect
// message was lost (e.g. transient driver error), this corrects the drift.
// each entry carries the tags forwarded from the reservation jwt so we can
// pass them to driver.connectClient — required for an upsert that doesn't
// half-resurrect an evicted record.
//
// heartbeatTimestamp is the wall-clock at which the room captured `roomClients`.
// the disconnect path gates on `driver.connectedAt < heartbeatTimestamp` so a
// client that connected after the snapshot was captured (and therefore couldn't
// possibly appear in `roomClients`) isn't mistaken for stale state and removed.
// without that gate, the heartbeat handler races client-connected ipc: under
// load the room admits a client between snapshot capture and heartbeat arrival,
// the driver writes it as connected before the reconciler reads, and the
// reconciler then disconnects a live peer.
async function reconcileClients(driver, roomId, roomClients, heartbeatTimestamp) {
    const roomInfo = await driver.getRoomInfo(roomId);
    if (!roomInfo)
        return; // room already gone
    const roomSet = new Set(roomClients.map((c) => c.clientId));
    // clients the room says are connected but the driver doesn't have as 'connected'
    for (const { clientId, tags } of roomClients) {
        const driverClient = roomInfo.clients.find((c) => c.clientId === clientId);
        if (!driverClient || driverClient.status !== 'connected') {
            log.info('reconcile: connecting client missing from driver', { roomId, clientId });
            await driver.connectClient(clientId, roomId, tags).catch((err) => {
                log.error('reconcile: failed to connect client', { roomId, clientId, err });
            });
        }
    }
    // clients the driver thinks are connected but the room doesn't have.
    // skip clients whose connectedAt is after the heartbeat snapshot — the room
    // couldn't have known about them yet, so absence is not evidence of staleness.
    for (const driverClient of roomInfo.clients) {
        if (driverClient.status === 'connected' &&
            !roomSet.has(driverClient.clientId) &&
            driverClient.connectedAt < heartbeatTimestamp) {
            log.info('reconcile: disconnecting stale client from driver', { roomId, clientId: driverClient.clientId });
            await driver.disconnectClient(driverClient.clientId).catch((err) => {
                log.error('reconcile: failed to disconnect client', { roomId, clientId: driverClient.clientId, err });
            });
        }
    }
}
// handle all notify messages from a room.
// single dispatch point — every room→server message type is handled here.
function handleNotifyMessage(s, roomId, msg) {
    switch (msg.type) {
        case 'heartbeat': {
            s.lastHeartbeats.set(roomId, Date.now());
            const proc = s.processes.get(roomId);
            log.debug('room heartbeat', {
                roomId,
                roomType: proc?.roomType,
                memoryRss: msg.metrics?.memoryRss,
                memoryHeapUsed: msg.metrics?.memoryHeapUsed,
                cpuUser: msg.metrics?.cpuUser,
                cpuSystem: msg.metrics?.cpuSystem,
                clientCount: msg.clients.length,
            });
            // reconcile client state in the background — don't block the heartbeat path
            reconcileClients(s.driver, roomId, msg.clients, msg.timestamp).catch((err) => {
                log.error('client reconciliation failed', { roomId, err });
            });
            break;
        }
        case 'ready': {
            const proc = s.processes.get(roomId);
            if (!proc) {
                log.error('received ready for unknown room', { roomId });
                break;
            }
            const endpoint = s.options.roomEndpoint({ roomId, port: msg.port });
            proc.endpoint = endpoint;
            s.driver.roomReady(roomId, endpoint, proc.roomSecret).then((wanted) => {
                if (wanted)
                    return;
                // the caller gave up before it came up; nothing will route a client here
                log.warn('room ready but no longer wanted, destroying', { roomId });
                destroyWorker(s, roomId);
            }, (err) => {
                log.error('failed to mark room as ready', { roomId, err });
            });
            log.info('room ready', { roomId, roomType: proc.roomType, wsPort: msg.port, endpoint });
            break;
        }
        case 'client-connected': {
            s.driver.connectClient(msg.clientId, msg.roomId, msg.tags).catch((err) => {
                log.error('failed to connect client in driver', { roomId, clientId: msg.clientId, err });
            });
            break;
        }
        case 'client-disconnected': {
            s.driver.disconnectClient(msg.clientId).catch((err) => {
                log.error('failed to disconnect client in driver', { roomId, clientId: msg.clientId, err });
            });
            break;
        }
        case 'stopped': {
            cleanupRoom(s, roomId, 'self-stopped');
            break;
        }
        case 'error': {
            log.error('room error', { roomId, message: msg.message });
            break;
        }
    }
}
/* room lifecycle */
// spawn a new room via the injected runner.
// 1. registers the room process handle, then calls runner.spawn() with two
//    injected sinks: `notifier` (room→server notify messages, however the runner
//    chooses to carry them) and `stopped` (the runner's observation that the
//    room exited).
// 2. waits for the room's first notify message before resolving — a room that
//    exits or stays silent past the startup timeout is a spawn failure.
// 3. when the room sends 'ready' with its ws port, computes the endpoint and
//    registers with the driver.
async function createRoom(s, roomId, roomType, data) {
    const runner = s.runners.get(roomType);
    if (!runner) {
        throw new Error(`no runner for room type "${roomType}"`);
    }
    const roomSecret = randomBytes$1(32).toString('base64url');
    let resolveExited;
    const exited = new Promise((r) => {
        resolveExited = r;
    });
    // startup gate: resolves on the room's first notify message, rejects if the
    // room exits (or stays silent past the timeout) before ever speaking.
    let started = false;
    let stoppedCalled = false;
    let status = 'starting';
    const roomProcess = {
        roomId,
        roomType,
        roomSecret,
        data,
        endpoint: null,
        status: () => status,
        kill: () => { },
        exited,
        markExited: () => resolveExited(),
    };
    // register before spawn — the room's first notify message (often `ready`)
    // must find the process entry in place. note: lastHeartbeats is NOT seeded
    // here — the stall sweep must not tick against a room that hasn't spoken
    // yet, or it would cut the startup budget down to the stall timeout.
    // the clock starts on the first notify message.
    s.processes.set(roomId, roomProcess);
    let settleStarted;
    const startedPromise = new Promise((resolve, reject) => {
        settleStarted = { resolve, reject };
    });
    const onMessage = (msg) => {
        // drop messages once the room has exited or been cleaned up — a late
        // heartbeat must not resurrect bookkeeping for a dead room.
        if (stoppedCalled || !s.processes.has(roomId))
            return;
        if (!started) {
            started = true;
            s.lastHeartbeats.set(roomId, Date.now());
            settleStarted.resolve();
        }
        if (msg.type === 'ready' && status === 'starting')
            status = 'ready';
        if (msg.type === 'stopped')
            status = 'stopped';
        handleNotifyMessage(s, roomId, msg);
    };
    function stopped(code) {
        if (stoppedCalled)
            return;
        stoppedCalled = true;
        status = 'stopped';
        if (!started) {
            settleStarted.reject(new Error(`room process exited during startup (code ${code})`));
        }
        else {
            cleanupRoom(s, roomId, 'process-exited');
        }
    }
    const spawnResult = runner.spawn({
        roomId,
        roomType,
        serverId: s.serverId,
        roomSecret,
        data,
        onMessage,
        stopped,
        status: () => status,
    });
    roomProcess.kill = () => spawnResult.kill();
    const startupTimeoutMs = s.options.roomStartupTimeoutMs ?? DEFAULT_ROOM_STARTUP_TIMEOUT_MS;
    const startupTimeout = setTimeout(() => {
        settleStarted.reject(new Error(`room sent no notify message within ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);
    startupTimeout.unref();
    try {
        await startedPromise;
    }
    catch (err) {
        // startup failed — unregister and make sure nothing lingers. on the
        // timeout path the room may still be running; kill() is a no-op for a
        // room that already exited.
        s.processes.delete(roomId);
        s.lastHeartbeats.delete(roomId);
        spawnResult.kill();
        roomProcess.markExited();
        throw err;
    }
    finally {
        clearTimeout(startupTimeout);
    }
    return roomProcess;
}
// kill a room process. the runner's kill() handles signal escalation
// (e.g. SIGTERM then SIGKILL). cleanup happens via the onExit handler
// which calls cleanupRoom.
function destroyWorker(s, roomId) {
    const roomProcess = s.processes.get(roomId);
    if (!roomProcess)
        return;
    s.killedRoomIds.add(roomId);
    roomProcess.kill();
}
function shutdownAllWorkers(s) {
    for (const roomId of Array.from(s.processes.keys())) {
        destroyWorker(s, roomId);
    }
}
/* heartbeat monitoring */
// sweep all process heartbeats — called at the top of each reconcile tick.
// kills stalled processes and reports failure to the driver.
function checkHeartbeats(s) {
    const now = Date.now();
    const stallTimeoutMs = s.options.roomStallTimeoutMs ?? DEFAULT_ROOM_STALL_TIMEOUT_MS;
    for (const [roomId, lastBeat] of s.lastHeartbeats) {
        if (now - lastBeat > stallTimeoutMs) {
            const roomProcess = s.processes.get(roomId);
            if (roomProcess) {
                log.warn('process stalled, killing', { roomId, stalledMs: now - lastBeat });
                // add to killedRoomIds so the subsequent process-exited event
                // doesn't double-report — heartbeat-timeout already calls roomFailure
                s.killedRoomIds.add(roomId);
                roomProcess.kill();
                cleanupRoom(s, roomId, 'heartbeat-timeout');
            }
        }
    }
}
/* room spawning */
// the one spawn path, from the assignment push (fast) and the heartbeat reconcile (guaranteed)
function spawnAssignedRoom(s, room) {
    if (!s.alive)
        return;
    if (s.processes.has(room.roomId))
        return;
    if (s.spawning.has(room.roomId))
        return;
    if (s.attempted.has(room.roomId))
        return;
    s.attempted.set(room.roomId, Date.now());
    s.spawning.add(room.roomId);
    createRoom(s, room.roomId, room.roomType, room.data)
        .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        log.error('room failed to start', { roomId: room.roomId, reason });
        s.driver.roomFailure(room.roomId, reason).catch((e) => {
            log.error('failed to report room failure', { roomId: room.roomId, err: e });
        });
    })
        .finally(() => {
        s.spawning.delete(room.roomId);
    });
}
async function startRoomSubscription(s) {
    s.unsubscribeRoomAssignments = await s.driver.subscribeRoomAssignments(s.serverId, (room) => {
        spawnAssignedRoom(s, room);
    });
}
function stopRoomSubscription(s) {
    if (s.unsubscribeRoomAssignments) {
        s.unsubscribeRoomAssignments();
        s.unsubscribeRoomAssignments = null;
    }
}
/* heartbeat loop — heartbeat + room reconciliation in one tick */
// every tick: send a heartbeat (which doubles as registration if our record was
// reaped), refresh the cached tag state from what the driver returns, sweep local
// process heartbeats, and kill any rooms that are no longer in the desired set
// returned by the heartbeat. push-based subscribeRoomAssignments handles new
// assignments instantly; this loop is the safety net for missed pushes plus the
// authoritative source for "which rooms should this server be running right now".
async function heartbeatTick(s, adminEndpoint, isCurrent) {
    logHeartbeatOutage(s);
    // rooms spawned after this point may be missing from the snapshot: newer, not unwanted
    const snapshotRequestedAt = Date.now();
    const result = await s.driver.heartbeat({
        serverId: s.serverId,
        endpoint: adminEndpoint,
        tags: s.serverTags,
        roomTypes: Array.from(s.knownRoomTypes),
    });
    // the heartbeat round-trip may have outlived this tick's timeout: a fresh
    // tick is already reconciling against newer state. discard our now-stale
    // conclusions rather than writing them back and destroying rooms the newer
    // tick's desired-set still wants.
    if (!isCurrent()) {
        log.warn('discarding stale heartbeat tick result', { serverId: s.serverId });
        return;
    }
    s.serverTags = result.tags;
    s.lastDriverHeartbeatAt = Date.now();
    if (s.heartbeatOutageLogged) {
        s.heartbeatOutageLogged = false;
        log.info('driver heartbeat recovered', { serverId: s.serverId });
    }
    checkHeartbeats(s);
    const desiredIds = new Set(result.desiredRooms.map((r) => r.roomId));
    // reap-recovery: our server record was reaped (e.g. a driver blip stalled our
    // heartbeats past the staleness threshold) while we were still alive and
    // running rooms. this heartbeat re-created the record (registered: true) but
    // it comes back with an EMPTY desired-set — reaping the server also deleted
    // its room records. without intervention the destroy sweep below would kill
    // every healthy, client-occupied room. instead, re-assert our still-running
    // local rooms into the driver BEFORE the sweep so they survive.
    const reasserted = new Set();
    if (result.registered && s.previouslyRegistered) {
        const restoredRoomIds = [];
        for (const proc of s.processes.values()) {
            // only re-assert rooms that are actually ready and NOT already in the
            // driver's desired set. a room still present in desiredRooms doesn't
            // need re-asserting (its record survived). checking desiredRooms also
            // guards against fighting a deliberate destroy: if an sdk destroyed a
            // room during the outage, registerRoom would recreate it — but a
            // destroyed room won't be in our processes-with-ready-status set for
            // long, and more importantly we accept the tradeoff that a deliberate
            // sdk destroy landing DURING the outage gets re-asserted here and then
            // re-destroyed on the next reconcile after the sdk retries. that window
            // is bounded by one heartbeat interval and never resurrects a room the
            // sdk has finished tearing down before the reap.
            if (proc.status() !== 'ready')
                continue;
            if (desiredIds.has(proc.roomId))
                continue;
            if (!proc.endpoint)
                continue;
            // note: room tags from the original sdk.createRoom are NOT persisted
            // on the RoomProcess, so they cannot be restored here — re-register
            // with empty tags. building tag persistence is out of scope; we warn.
            try {
                // the ttl only has to bridge the roomReady right below, which persists the record
                const ttlMs = s.options.roomStartupTimeoutMs ?? DEFAULT_ROOM_STARTUP_TIMEOUT_MS;
                await s.driver.registerRoom(proc.roomId, proc.roomType, s.serverId, proc.data, {}, ttlMs);
                await s.driver.roomReady(proc.roomId, proc.endpoint, proc.roomSecret);
                reasserted.add(proc.roomId);
                restoredRoomIds.push(proc.roomId);
            }
            catch (err) {
                log.error('failed to re-assert room after server reap', { roomId: proc.roomId, err });
            }
        }
        log.warn('restored missing server entry — record was reaped while alive', {
            serverId: s.serverId,
            tags: s.serverTags,
            restoredRoomIds,
            note: 'room tags from the original createRoom were NOT restored (not persisted on the server)',
        });
    }
    s.previouslyRegistered = true;
    // destroy sweep: kill any local room no longer wanted by the driver. skip the
    // rooms we just re-asserted this tick — the heartbeat's desired-set predates
    // our re-registration and would otherwise cause us to destroy exactly the
    // rooms we just restored.
    for (const roomId of s.processes.keys()) {
        if (reasserted.has(roomId))
            continue;
        if (spawnedAfter(s, roomId, snapshotRequestedAt))
            continue;
        if (!desiredIds.has(roomId)) {
            destroyWorker(s, roomId);
        }
    }
    // reap-recovery above awaits the driver; a newer tick may own the state by now
    if (!isCurrent())
        return;
    reconcileDesiredRooms(s, result.desiredRooms, snapshotRequestedAt);
}
function spawnedAfter(s, roomId, at) {
    const attemptedAt = s.attempted.get(roomId);
    return attemptedAt !== undefined && attemptedAt >= at;
}
// level-triggered spawning: the stored desired set is the truth, whatever the push delivered or lost
function reconcileDesiredRooms(s, desiredRooms, snapshotRequestedAt) {
    const now = Date.now();
    const lostGraceMs = s.options.roomStallTimeoutMs ?? DEFAULT_ROOM_STALL_TIMEOUT_MS;
    const desiredIds = new Set();
    for (const room of desiredRooms) {
        desiredIds.add(room.roomId);
        if (s.processes.has(room.roomId) || s.spawning.has(room.roomId)) {
            s.lostSince.delete(room.roomId);
            continue;
        }
        if (room.status === 'requested') {
            spawnAssignedRoom(s, room);
            continue;
        }
        const lostAt = s.lostSince.get(room.roomId);
        if (lostAt === undefined) {
            s.lostSince.set(room.roomId, now);
            continue;
        }
        if (now - lostAt < lostGraceMs)
            continue;
        s.lostSince.delete(room.roomId);
        log.warn('room running in driver but not on this server, reporting failure', {
            roomId: room.roomId,
            lostMs: now - lostAt,
        });
        s.driver.roomFailure(room.roomId, 'room process lost').catch((err) => {
            log.error('failed to report room failure', { roomId: room.roomId, err });
        });
    }
    for (const roomId of s.lostSince.keys()) {
        if (!desiredIds.has(roomId))
            s.lostSince.delete(roomId);
    }
    // roomIds are never reused; forgetting an attempt early could respawn a room whose failure is in flight
    for (const [roomId, attemptedAt] of s.attempted) {
        if (desiredIds.has(roomId) || spawnedAfter(s, roomId, snapshotRequestedAt))
            continue;
        if (now - attemptedAt > ATTEMPT_RETENTION_MS)
            s.attempted.delete(roomId);
    }
}
// the driver outage itself shows up as generic tick timeouts; name it once
function logHeartbeatOutage(s) {
    if (s.heartbeatOutageLogged)
        return;
    const intervalMs = s.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const sinceLastSuccessMs = Date.now() - s.lastDriverHeartbeatAt;
    if (sinceLastSuccessMs <= HEARTBEAT_OUTAGE_LOG_AFTER_INTERVALS * intervalMs)
        return;
    s.heartbeatOutageLogged = true;
    log.error('driver heartbeat failing', { serverId: s.serverId, sinceLastSuccessMs });
}
async function startHeartbeatLoop(s, adminEndpoint, intervalMs) {
    if (s.heartbeatPunctuator)
        return;
    s.heartbeatPunctuator = await punctuate('heartbeat loop', (isCurrent) => heartbeatTick(s, adminEndpoint, isCurrent), {
        intervalMs,
        timeoutMs: HEARTBEAT_TICK_TIMEOUT_MS,
        logger: log.child({ serverId: s.serverId }),
    });
}
function stopHeartbeatLoop(s) {
    if (s.heartbeatPunctuator) {
        s.heartbeatPunctuator.stop();
        s.heartbeatPunctuator = null;
    }
}
/* leader election & duties */
async function reapStaleServers(s) {
    const stale = await s.driver.listStaleServers();
    await Promise.all(stale.map(async (server) => {
        // re-checked atomically: a heartbeat that landed since the listing wins
        const reaped = await s.driver.reapServer(server.serverId);
        if (reaped)
            log.info('reaped stale server', { staleServerId: server.serverId, endpoint: server.endpoint });
    }));
}
async function cleanOrphanedRoomEntries(s) {
    // snapshot servers first, then rooms. a room created after the servers
    // snapshot won't appear in server.rooms, so it can't be falsely flagged
    // as orphaned. the reverse ordering was racy: a room created between
    // listRooms() and listServers() would appear in server.rooms but not
    // in the rooms snapshot, getting incorrectly deleted.
    const servers = await s.driver.listServers();
    const staleServers = await s.driver.listStaleServers();
    const allServers = [...servers, ...staleServers];
    // collect all room ids referenced by servers
    const serverRoomIds = new Set();
    for (const server of allServers) {
        for (const room of server.rooms) {
            serverRoomIds.add(room.roomId);
        }
    }
    // now snapshot rooms — any room in the server list but not in the rooms
    // map is truly orphaned (the room entry was deleted but the server still
    // references it). this direction is safe: rooms created after the servers
    // snapshot aren't in serverRoomIds, so they're never touched.
    const allRooms = await s.driver.listRooms();
    const liveRoomIds = new Set(allRooms.map((r) => r.roomId));
    const orphaned = Array.from(serverRoomIds).filter((id) => !liveRoomIds.has(id));
    await Promise.all(orphaned.map((roomId) => s.driver.unregisterRoom(roomId)));
}
async function runLeaderDuties(s) {
    await reapStaleServers(s);
    await cleanOrphanedRoomEntries(s);
}
// single loop covering both election and renewal: branches on s.isLeader.
// errors/timeouts log under 'leader loop error' and retry next tick — we
// don't flip isLeader on driver error because the lock ttl may still be live.
async function startLeaderLoop(s) {
    s.leaderPunctuator = await punctuate('leader loop', async (isCurrent) => {
        if (s.isLeader) {
            const renewed = await s.driver.renewLeader(s.serverId);
            // a renewal that outlived this tick's timeout must not write
            // leadership state or run duties: a fresh tick is authoritative
            // and may already have re-renewed or dropped leadership. the
            // duties themselves are driver-side idempotent (they only reap
            // genuinely-stale servers / orphaned rooms), but the s.isLeader
            // write and the wasted work are the real hazard here.
            if (!isCurrent()) {
                log.warn('discarding stale leader renewal result', { serverId: s.serverId });
                return;
            }
            if (!renewed) {
                log.warn('lost leadership (renewal failed)', { serverId: s.serverId });
                s.isLeader = false;
                return;
            }
            await runLeaderDuties(s);
        }
        else {
            const acquired = await s.driver.tryAcquireLeader(s.serverId);
            if (!isCurrent()) {
                log.warn('discarding stale leader acquisition result', { serverId: s.serverId });
                return;
            }
            if (acquired) {
                s.isLeader = true;
                log.info('acquired leadership', { serverId: s.serverId });
                await runLeaderDuties(s);
            }
        }
    }, {
        intervalMs: LEADER_LOOP_INTERVAL_MS,
        timeoutMs: LEADER_LOOP_TIMEOUT_MS,
        logger: log.child({ serverId: s.serverId }),
    });
}
function stopLeaderLoop(s) {
    if (s.leaderPunctuator) {
        s.leaderPunctuator.stop();
        s.leaderPunctuator = null;
    }
}
/* http handling */
function handleRequest(_req, res) {
    if (_req.url === '/health' && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }
    if (_req.url === '/ping' && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
        return;
    }
    res.writeHead(404);
    res.end();
}
/* server lifecycle */
async function startInternal(s) {
    s.httpServer = http.createServer(handleRequest);
    s.httpServer.on('connection', (socket) => {
        s.openSockets.add(socket);
        socket.on('close', () => s.openSockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        s.httpServer.on('error', reject);
        s.httpServer.listen(s.port, s.host, () => {
            const addr = s.httpServer.address();
            if (addr && typeof addr === 'object') {
                s.currentAddress = {
                    host: addr.address,
                    port: addr.port,
                };
            }
            resolve();
        });
    });
    // replace the startup error listener with a persistent one — without this,
    // post-startup http errors (e.g. ECONNRESET) become uncaught EventEmitter errors.
    s.httpServer.removeAllListeners('error');
    s.httpServer.on('error', (err) => {
        log.error('http server error', { err });
    });
    const serverHost = s.currentAddress?.host ?? s.host;
    const serverPort = s.currentAddress?.port ?? s.port;
    const serverEndpoint = s.options.serverEndpoint ?? `http://${serverHost}:${serverPort}`;
    // subscribe to room assignments before the first heartbeat — registering
    // first would let an sdk assign a room before we're listening, dropping the
    // notification. push delivers new assignments instantly; the heartbeat loop
    // is the safety net for missed pushes plus the periodic kill-stale-rooms.
    await startRoomSubscription(s);
    // start the heartbeat loop. punctuate runs the first tick eagerly, so the
    // initial heartbeat (and therefore registration) is awaited before this
    // returns. transient driver failure on the first tick is logged and
    // retried by the loop — startup completes and self-heals in-process.
    await startHeartbeatLoop(s, serverEndpoint, s.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    await startLeaderLoop(s);
}
async function stop(s) {
    s.alive = false;
    // 1. stop room assignment subscription — no new spawns
    stopRoomSubscription(s);
    // 2. stop the heartbeat loop (heartbeat + reconcile)
    stopHeartbeatLoop(s);
    // 3. stop leader loop and release leader lock
    stopLeaderLoop(s);
    if (s.isLeader) {
        await s.driver.releaseLeader(s.serverId);
        s.isLeader = false;
    }
    // 4. unregister server from driver
    await s.driver.unregisterServer(s.serverId);
    // 6. terminate all room processes and wait for them to exit.
    // snapshot exit promises before killing — cleanupRoom deletes entries from s.processes.
    const exitPromises = Array.from(s.processes.values()).map((p) => p.exited);
    shutdownAllWorkers(s);
    if (exitPromises.length > 0) {
        const drainTimeoutMs = s.options.drainTimeoutMs ?? 10_000;
        await Promise.race([Promise.all(exitPromises), new Promise((r) => setTimeout(r, drainTimeoutMs))]);
    }
    // 7. destroy all open sockets and close http server
    for (const socket of s.openSockets) {
        socket.destroy();
    }
    s.openSockets.clear();
    if (s.httpServer) {
        await Promise.race([
            new Promise((resolve) => s.httpServer.close(() => resolve())),
            new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
        s.httpServer = null;
    }
    // 8. cleanup
    s.currentAddress = null;
}
/* introspection */
function getRoomDetails(s, roomId) {
    const roomProcess = s.processes.get(roomId);
    if (!roomProcess)
        return null;
    return {
        roomId,
        roomType: roomProcess.roomType,
        endpoint: roomProcess.endpoint,
        status: roomProcess.status(),
        lastHeartbeatAt: s.lastHeartbeats.get(roomId) ?? null,
    };
}
function getAllRoomDetails(s) {
    const details = [];
    for (const roomProcess of s.processes.values()) {
        details.push({
            roomId: roomProcess.roomId,
            roomType: roomProcess.roomType,
            endpoint: roomProcess.endpoint,
            status: roomProcess.status(),
            lastHeartbeatAt: s.lastHeartbeats.get(roomProcess.roomId) ?? null,
        });
    }
    return details;
}
/* start */
// wildcard hosts don't identify a reachable address. with a networked driver the
// bind host becomes the published serverEndpoint, so a wildcard means every server
// registers the same unroutable endpoint and they evict each other's rooms forever.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);
async function start(options) {
    const { _internal: driver } = options.driver;
    const runners = new Map(Object.entries(options.rooms));
    const host = options.host ?? '0.0.0.0';
    // fail fast: a networked driver publishes this server's endpoint to peers and
    // sdks. if the operator left serverEndpoint unset and the bind host is a
    // wildcard, the derived endpoint (http://0.0.0.0:port) is unroutable and every
    // server registers the same one — they mutually evict each other's rooms. a
    // local (in-process) driver shares state directly, so the endpoint is moot.
    if (!driver.local && !options.serverEndpoint && WILDCARD_HOSTS.has(host)) {
        throw new Error('gatho: serverEndpoint is required with a networked driver when binding a wildcard host ' +
            `(${host || 'unset'}). the endpoint is published to other servers and sdks, so it must be a ` +
            'url they can reach — set serverEndpoint to e.g. "http://10.0.0.5:3000".');
    }
    const s = {
        options,
        driver,
        runners,
        port: options.port ?? 3000,
        host,
        serverId: randomUUID(),
        knownRoomTypes: new Set(Object.keys(options.rooms)),
        processes: new Map(),
        lastHeartbeats: new Map(),
        killedRoomIds: new Set(),
        spawning: new Set(),
        attempted: new Map(),
        lostSince: new Map(),
        alive: true,
        openSockets: new Set(),
        heartbeatPunctuator: null,
        serverTags: options.tags ?? {},
        previouslyRegistered: false,
        unsubscribeRoomAssignments: null,
        isLeader: false,
        leaderPunctuator: null,
        httpServer: null,
        currentAddress: null,
        lastDriverHeartbeatAt: Date.now(),
        heartbeatOutageLogged: false,
    };
    await startInternal(s);
    return {
        serverId: s.serverId,
        stop: () => stop(s),
        address: () => s.currentAddress,
        getRoomDetails: (roomId) => getRoomDetails(s, roomId),
        getAllRoomDetails: () => getAllRoomDetails(s),
    };
}

const SIGKILL_DELAY_MS = 5_000;
/**
 * spawn-a-child-process room runner.
 *
 * the subprocess should build its room with `gatho/room`'s `create()` and call
 * `await room.start()` (`import { create } from 'gatho/room'`).
 *
 * establishes a uds notify channel, then starts the process with at least the standard
 * gatho environment variables, which `create()` picks up automatically:
 * - `GATHO_ROOM_ID`: the room's unique identifier
 * - `GATHO_ROOM_TYPE`: the room type string
 * - `GATHO_SERVER_ID`: the id of the server this room is running on
 * - `GATHO_ROOM_SECRET`: a per-room secret for signing JWTs
 * - `GATHO_NOTIFY_SOCKET`: where to dial the notify channel
 *
 * room-specific config (`ctx.data` in a custom `runner()`) is not forwarded automatically —
 * use `options.env` (or a custom runner) to pass it with whatever naming/transform you want.
 *
 * a spawn failure (e.g. missing binary) is surfaced as a synthesized `error` notify message
 * so it's visible in gatho's own reporting, not just the host's stderr.
 *
 * @param command the full argv array for the subprocess, e.g. `['bun', 'run', 'game-room.ts']`
 * @param options additional env vars, kill timeout, socket dir
 */
function subprocess(command, options) {
    const killTimeout = options?.killTimeoutMs ?? SIGKILL_DELAY_MS;
    return runner(async (ctx) => {
        const chan = await notify.uds(ctx, { socketDir: options?.socketDir });
        const userEnv = typeof options?.env === 'function' ? options.env(ctx) : options?.env;
        const env = {
            ...process.env,
            ...userEnv,
            ...ctx.env,
            ...chan.env,
        };
        const child = spawn(command[0], command.slice(1), {
            env: env,
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        // single exit path — 'error' (spawn failure) and 'exit' can both fire;
        // report once, then tear the channel down.
        let reported = false;
        function report(code) {
            if (reported)
                return;
            reported = true;
            chan.close();
            ctx.stopped(code);
        }
        child.on('exit', (code) => report(code));
        child.on('error', (err) => {
            ctx.onMessage({ type: 'error', message: `subprocess spawn failed: ${err.message}` });
            report(-1);
        });
        let killed = false;
        return () => {
            if (killed)
                return;
            killed = true;
            child.kill('SIGTERM');
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
            }, killTimeout);
            timer.unref();
        };
    });
}

export { notify, roomSocketPath, runner, start, subprocess };
//# sourceMappingURL=server.js.map
