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
export function utf8Length(s: string): number {
    const n = s.length;
    let bytes = 0;
    for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) {
            bytes += 1;
        } else if (c < 0x800) {
            bytes += 2;
        } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                bytes += 4;
                i++;
            } else {
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

export class Writer {
    buf: Uint8Array<ArrayBuffer> = new Uint8Array(INITIAL_CAPACITY);
    view = new DataView(this.buf.buffer);
    pos = 0;

    /** start a new message, discarding anything written by an encode that threw */
    begin(): void {
        this.pos = 0;
    }

    /** make room for `n` more bytes */
    ensure(n: number): void {
        const needed = this.pos + n;
        if (needed <= this.buf.length) return;
        let capacity = this.buf.length * 2;
        while (capacity < needed) capacity *= 2;
        const next = new Uint8Array(capacity);
        next.set(this.buf.subarray(0, this.pos));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    u8(value: number): void {
        this.ensure(1);
        this.buf[this.pos++] = value;
    }

    /** u16 little endian. throws when the value is not an integer in 0..65535 */
    u16(value: number): void {
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

    f64(value: number): void {
        this.ensure(8);
        this.view.setFloat64(this.pos, value, true);
        this.pos += 8;
    }

    /** unsigned LEB128, value must be an integer in 0..2^32-1 */
    varint(value: number): void {
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
    str(s: string): void {
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
                } else if (c < 0x800) {
                    buf[pos++] = 0xc0 | (c >> 6);
                    buf[pos++] = 0x80 | (c & 0x3f);
                } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
                    const d = s.charCodeAt(i + 1);
                    if (d >= 0xdc00 && d <= 0xdfff) {
                        const codePoint = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                        buf[pos++] = 0xf0 | (codePoint >> 18);
                        buf[pos++] = 0x80 | ((codePoint >> 12) & 0x3f);
                        buf[pos++] = 0x80 | ((codePoint >> 6) & 0x3f);
                        buf[pos++] = 0x80 | (codePoint & 0x3f);
                        i++;
                    } else {
                        buf[pos++] = 0xef;
                        buf[pos++] = 0xbf;
                        buf[pos++] = 0xbd;
                    }
                } else {
                    // a lone surrogate encodes as U+FFFD, same as TextEncoder
                    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
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
    reserveCount(): number {
        const at = this.pos;
        this.u8(0);
        return at;
    }

    /** fill in a count reserved with `reserveCount`, widening it if it needs more than one byte */
    patchCount(at: number, count: number): void {
        if (count < 0x80) {
            this.buf[at] = count;
            return;
        }
        let width = 1;
        for (let rest = count >>> 7; rest > 0; rest >>>= 7) width++;
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
    finish(): Uint8Array<ArrayBuffer> {
        const out = this.buf.slice(0, this.pos);
        this.release();
        return out;
    }

    private release(): void {
        this.pos = 0;
        if (this.buf.length > MAX_RETAINED_CAPACITY) {
            this.buf = new Uint8Array(INITIAL_CAPACITY);
            this.view = new DataView(this.buf.buffer);
        }
    }
}

export class Reader {
    buf: Uint8Array = EMPTY;
    pos = 0;
    end = 0;
    private view: DataView | null = null;

    /** start reading `bytes` at offset `start` */
    reset(bytes: Uint8Array, start: number): void {
        this.buf = bytes;
        this.pos = start;
        this.end = bytes.byteLength;
        this.view = null;
    }

    /** drop the reference to the input buffer */
    release(): void {
        this.buf = EMPTY;
        this.view = null;
    }

    private need(n: number): void {
        if (this.end - this.pos < n) {
            throw new Error('unexpected end of input');
        }
    }

    u8(): number {
        if (this.pos >= this.end) throw new Error('unexpected end of input');
        return this.buf[this.pos++];
    }

    u16(): number {
        this.need(2);
        const value = this.buf[this.pos] | (this.buf[this.pos + 1] << 8);
        this.pos += 2;
        return value;
    }

    f64(): number {
        this.need(8);
        if (this.view === null) {
            this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
        }
        const value = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return value;
    }

    /** unsigned LEB128 below 2^32, overlong encodings rejected */
    varint(): number {
        if (this.pos >= this.end) throw new Error('unexpected end of input');
        const first = this.buf[this.pos];
        if (first < 0x80) {
            this.pos++;
            return first;
        }
        return this.varintMultiByte();
    }

    private varintMultiByte(): number {
        const buf = this.buf;
        const end = this.end;
        let pos = this.pos;
        let value = 0;
        for (let shift = 0; shift < 35; shift += 7) {
            if (pos >= end) throw new Error('unexpected end of input');
            const byte = buf[pos++];
            // the fifth byte only has room for the top 4 bits of a uint32
            if (shift === 28 && byte > 0x0f) throw new Error('varint exceeds uint32');
            value += (byte & 0x7f) * 2 ** shift;
            if (byte < 0x80) {
                if (byte === 0 && shift > 0) throw new Error('overlong varint');
                this.pos = pos;
                return value;
            }
        }
        throw new Error('varint exceeds uint32');
    }

    /** a list or record entry count, rejected when the remaining input cannot hold that many items */
    count(minItemBytes: number): number {
        const count = this.varint();
        if (count * minItemBytes > this.end - this.pos) {
            throw new Error(`count ${count} exceeds remaining input`);
        }
        return count;
    }

    str(): string {
        const length = this.varint();
        const start = this.pos;
        if (length > this.end - start) {
            throw new Error(`string length ${length} exceeds remaining input`);
        }
        this.pos = start + length;
        if (length === 0) return '';

        if (length <= ASCII_DECODE_MAX_BYTES) {
            const buf = this.buf;
            let s = '';
            for (let i = start; i < start + length; i++) {
                const c = buf[i];
                if (c >= 0x80) return this.decodeUtf8(start, length);
                s += String.fromCharCode(c);
            }
            return s;
        }
        return this.decodeUtf8(start, length);
    }

    private decodeUtf8(start: number, length: number): string {
        try {
            return strictTextDecoder.decode(this.buf.subarray(start, start + length));
        } catch {
            throw new Error('invalid utf-8 in string');
        }
    }

    /** throw if any bytes remain after a message */
    finish(): void {
        if (this.pos !== this.end) {
            throw new Error(`${this.end - this.pos} trailing bytes after message`);
        }
    }
}
