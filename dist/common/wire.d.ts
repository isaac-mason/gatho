/** utf-8 byte length of a string, matching `TextEncoder` (lone surrogates are 3 bytes) */
export declare function utf8Length(s: string): number;
export declare class Writer {
    buf: Uint8Array<ArrayBuffer>;
    view: DataView<ArrayBuffer>;
    pos: number;
    /** start a new message, discarding anything written by an encode that threw */
    begin(): void;
    /** make room for `n` more bytes */
    ensure(n: number): void;
    u8(value: number): void;
    /** u16 little endian. throws when the value is not an integer in 0..65535 */
    u16(value: number): void;
    f64(value: number): void;
    /** unsigned LEB128, value must be an integer in 0..2^32-1 */
    varint(value: number): void;
    /** varint byte length followed by utf-8 bytes */
    str(s: string): void;
    /** write a count whose value is only known after its items were written.
     *  reserve it with `reserveCount` before the items. */
    reserveCount(): number;
    /** fill in a count reserved with `reserveCount`, widening it if it needs more than one byte */
    patchCount(at: number, count: number): void;
    /** copy the written bytes out into one exact-size array and reset */
    finish(): Uint8Array<ArrayBuffer>;
    private release;
}
export declare class Reader {
    buf: Uint8Array;
    pos: number;
    end: number;
    private view;
    /** start reading `bytes` at offset `start` */
    reset(bytes: Uint8Array, start: number): void;
    /** drop the reference to the input buffer */
    release(): void;
    private need;
    u8(): number;
    u16(): number;
    f64(): number;
    /** unsigned LEB128 below 2^32, overlong encodings rejected */
    varint(): number;
    private varintMultiByte;
    /** a list or record entry count, rejected when the remaining input cannot hold that many items */
    count(minItemBytes: number): number;
    str(): string;
    private decodeUtf8;
    /** throw if any bytes remain after a message */
    finish(): void;
}
