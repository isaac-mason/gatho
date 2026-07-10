/* lightweight helpers that just return objects */
/**
 * Boolean schema - stores true/false values using 1 byte.
 *
 * @returns A boolean schema definition
 *
 * @example
 * boolean() // Stores boolean value (1 byte)
 */
/**
 * String schema - variable-length UTF-8 encoded strings.
 *
 * Strings are prefixed with a varuint length followed by UTF-8 bytes.
 *
 * @returns A string schema definition
 *
 * @example
 * string() // Variable-length string
 */
const string = () => ({ type: 'string' });
/**
 * 16-bit unsigned integer (2 bytes).
 *
 * Range: 0 to 65,535
 *
 * @returns A uint16 schema definition
 *
 * @example
 * uint16() // 2 bytes unsigned integer
 */
const uint16 = () => ({ type: 'uint16' });
/**
 * 64-bit floating point (8 bytes) - double precision.
 *
 * Range: ±1.7e308 with ~15 decimal digits of precision
 * This is JavaScript's native number type.
 *
 * @returns A float64 schema definition
 *
 * @example
 * float64() // 8 bytes floating point
 */
const float64 = () => ({ type: 'float64' });
function list(of, length) {
    return ({ type: 'list', of } );
}
/**
 * Object schema - fixed set of named fields.
 *
 * Fields are serialized in alphabetically sorted order (by field name).
 * Field names are not stored in the binary format.
 *
 * @param fields Record mapping field names to their schemas
 * @returns An object schema definition
 *
 * @example
 * object({
 *   id: uint32(),
 *   position: tuple([float32(), float32(), float32()]),
 *   health: uint8()
 * })
 */
const object = (fields) => ({
    type: 'object',
    fields,
});
/**
 * Record schema - dynamic key-value map with homogeneous values.
 *
 * Keys are strings, all values share the same schema.
 * Stored as varuint count followed by [key, value] pairs.
 *
 * @param field Schema for all values
 * @returns A record schema definition
 *
 * @example
 * // Map of player IDs to scores
 * record(uint32())
 *
 * @example
 * // Map of item names to quantities
 * record(varuint())
 */
const record = (field) => ({
    type: 'record',
    field,
});
/**
 * Literal schema - constant value that doesn't need to be serialized.
 *
 * The value is part of the schema definition and takes 0 bytes to encode.
 * Useful for discriminators in unions or constant metadata.
 *
 * @param value The constant primitive value
 * @returns A literal schema definition
 */
const literal = (value) => {
    return { type: 'literal', value };
};
/**
 * Optional schema - value that can be undefined.
 *
 * Uses 1 byte to indicate presence (0=undefined, 1=present), followed by the value if defined.
 *
 * @param of - Schema for the defined value
 * @returns An optional schema definition
 *
 * @example
 * optional(uint32()) // number | undefined
 *
 * @example
 * optional(string()) // string | undefined
 */
const optional = (of) => ({ type: 'optional', of });
/**
 * Union schema - discriminated union of object variants.
 *
 * Each variant must be an object with a literal discriminator field.
 * The discriminator is used to determine which variant to deserialize.
 *
 * @param key - Name of the discriminator field
 * @param variants - Array of object schemas, each with a literal for the key field
 * @returns A union schema definition
 *
 * @example
 * union('type', [
 *   object({ type: literal('player'), id: uint32(), name: string() }),
 *   object({ type: literal('enemy'), id: uint32(), level: uint8() }),
 *   object({ type: literal('npc'), id: uint32(), dialog: string() })
 * ])
 */
const union = (key, variants) => ({
    type: 'union',
    key,
    variants,
});

function build(schema) {
    const { pack: packSource, packInto: packIntoSource } = buildPack(schema);
    const pack = new Function('textEncoder', 'f16', 'f16_u8', 'f32', 'f32_u8', 'f64', 'f64_u8', 'i64', 'i64_u8', 'u64', 'u64_u8', 'utf8Length', 'value', packSource).bind(null, textEncoder$1, f16, f16_u8, f32, f32_u8, f64, f64_u8, i64, i64_u8, u64, u64_u8, utf8Length);
    const packInto = new Function('textEncoder', 'f16', 'f16_u8', 'f32', 'f32_u8', 'f64', 'f64_u8', 'i64', 'i64_u8', 'u64', 'u64_u8', 'utf8Length', 'value', 'u8', 'offset', packIntoSource).bind(null, textEncoder$1, f16, f16_u8, f32, f32_u8, f64, f64_u8, i64, i64_u8, u64, u64_u8, utf8Length);
    const unpackSource = buildUnpack(schema);
    const unpack = new Function('textDecoder', 'f16', 'f16_u8', 'f32', 'f32_u8', 'f64', 'f64_u8', 'i64', 'i64_u8', 'u64', 'u64_u8', 'u8', unpackSource).bind(null, textDecoder$1, f16, f16_u8, f32, f32_u8, f64, f64_u8, i64, i64_u8, u64, u64_u8);
    const validateSource = buildValidate(schema);
    const validate = new Function('value', validateSource);
    return {
        pack,
        packInto,
        unpack,
        validate,
        source: { pack: packSource, unpack: unpackSource, validate: validateSource, packInto: packIntoSource },
    };
}
function buildPack(schema) {
    const ctx = createCtx();
    let preamble = '';
    preamble += 'let len = 0;';
    preamble += 'let vint = 0;';
    preamble += 'let vuint = 0;';
    preamble += 'let keys;';
    preamble += 'let val = 0;';
    const calc = size(ctx, schema, 'value');
    preamble += `let size = ${calc.fixed};`;
    preamble += calc.code;
    const body = pack(ctx, schema, 'value');
    const packSource = preamble +
        'const arrayBuffer = new ArrayBuffer(size);' +
        'let o = 0;' +
        'const u8 = new Uint8Array(arrayBuffer); ' +
        body +
        'return u8;';
    const packIntoSource = preamble +
        'let o = offset;' +
        'if (o + size > u8.length) return { ok: false, bytesWritten: 0 };' +
        body +
        'return { ok: true, bytesWritten: size };';
    return {
        pack: packSource,
        packInto: packIntoSource,
    };
}
function buildUnpack(schema) {
    const ctx = createCtx();
    let code = '';
    code += 'let o = 0;';
    code += 'let len = 0;';
    code += 'let val = 0;';
    code += 'let shift = 0;';
    code += 'let byte = 0;';
    code += 'let value;';
    code += unpack(ctx, schema, 'value');
    code += 'return value;';
    return code;
}
function buildValidate(schema) {
    const ctx = createCtx();
    let code = '';
    code += validate(ctx, schema, 'value');
    code += 'return true;';
    return code;
}
const f16_buffer = new ArrayBuffer(2);
const f16 = new Float16Array(f16_buffer);
const f16_u8 = new Uint8Array(f16_buffer);
const f32_buffer = new ArrayBuffer(4);
const f32 = new Float32Array(f32_buffer);
const f32_u8 = new Uint8Array(f32_buffer);
const f64_buffer = new ArrayBuffer(8);
const f64 = new Float64Array(f64_buffer);
const f64_u8 = new Uint8Array(f64_buffer);
const i64_buffer = new ArrayBuffer(8);
const i64 = new BigInt64Array(i64_buffer);
const i64_u8 = new Uint8Array(i64_buffer);
const u64_buffer = new ArrayBuffer(8);
const u64 = new BigUint64Array(u64_buffer);
const u64_u8 = new Uint8Array(u64_buffer);
const textEncoder$1 = new TextEncoder();
const textDecoder$1 = new TextDecoder();
function utf8Length(s) {
    let l = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) {
            l += 1;
        }
        else if (c < 0x800) {
            l += 2;
        }
        else if (c >= 0xd800 && c <= 0xdbff) {
            // high surrogate
            const c2 = s.charCodeAt(i + 1);
            if (c2 >= 0xdc00 && c2 <= 0xdfff) {
                l += 4;
                i++; // valid surrogate pair
            }
            else {
                l += 3; // unpaired surrogate
            }
        }
        else {
            l += 3;
        }
    }
    return l;
}
function createCtx() {
    return { counter: 1 };
}
function variable(ctx, str) {
    return str + ctx.counter++;
}
function partition(items, pred) {
    const yes = [];
    const no = [];
    for (const item of items) {
        if (pred(item))
            yes.push(item);
        else
            no.push(item);
    }
    return [yes, no];
}
/** static bitpack: compile-time known boolean refs */
function emitBitPack(ctx, boolRefs) {
    if (boolRefs.length === 0)
        return '';
    const bytes = Math.ceil(boolRefs.length / 8);
    const byteVar = variable(ctx, 'byte');
    let code = `let ${byteVar};`;
    for (let b = 0; b < bytes; b++) {
        code += `${byteVar} = 0;`;
        for (let bit = 0; bit < 8; bit++) {
            const idx = b * 8 + bit;
            if (idx >= boolRefs.length)
                break;
            code += `if (${boolRefs[idx].varRef}) ${byteVar} |= ${1 << bit};`;
        }
        code += `u8[o++] = ${byteVar};`;
    }
    return code;
}
/** static bitunpack: compile-time known boolean targets */
function emitBitUnpack(ctx, boolTargets) {
    if (boolTargets.length === 0)
        return '';
    const bytes = Math.ceil(boolTargets.length / 8);
    let code = '';
    for (let b = 0; b < bytes; b++) {
        const byteIdx = variable(ctx, 'bval');
        code += `const ${byteIdx} = u8[o++];`;
        for (let bit = 0; bit < 8; bit++) {
            const idx = b * 8 + bit;
            if (idx >= boolTargets.length)
                break;
            code += `${boolTargets[idx].target} = (${byteIdx} & ${1 << bit}) !== 0;`;
        }
    }
    return code;
}
function size(ctx, s, v) {
    return handlers[s.type].size(ctx, s, v);
}
function pack(ctx, s, v) {
    return handlers[s.type].pack(ctx, s, v);
}
function unpack(ctx, s, target) {
    return handlers[s.type].unpack(ctx, s, target);
}
function validate(ctx, s, v) {
    return handlers[s.type].validate(ctx, s, v);
}
/** creates a handler for a fixed-size numeric type */
function fixedHandler(bytes, packFn, unpackFn, validateCode) {
    return {
        size: () => ({ code: '', fixed: bytes }),
        pack: (_ctx, _s, v) => packFn(v),
        unpack: (_ctx, _s, t) => unpackFn(t),
        validate: (_ctx, _s, v) => validateCode(v),
    };
}
const handlers = {
    boolean: fixedHandler(1, writeBool, readBool, (v) => `if (typeof ${v} !== 'boolean') return false;`),
    int8: fixedHandler(1, writeI8, readI8, (v) => `if (typeof ${v} !== 'number' || !Number.isInteger(${v}) || ${v} < -128 || ${v} > 127) return false;`),
    uint8: fixedHandler(1, writeU8, readU8, (v) => `if (typeof ${v} !== 'number' || !Number.isInteger(${v}) || ${v} < 0 || ${v} > 255) return false;`),
    int16: fixedHandler(2, writeI16, readI16, (v) => `if (typeof ${v} !== 'number' || !Number.isInteger(${v}) || ${v} < -32768 || ${v} > 32767) return false;`),
    uint16: fixedHandler(2, writeU16, readU16, (v) => `if (typeof ${v} !== 'number' || !Number.isInteger(${v}) || ${v} < 0 || ${v} > 65535) return false;`),
    int32: fixedHandler(4, writeI32, readI32, (v) => `if (typeof ${v} !== 'number' || !Number.isInteger(${v}) || ${v} < -2147483648 || ${v} > 2147483647) return false;`),
    uint32: fixedHandler(4, writeU32, readU32, (v) => `if (typeof ${v} !== 'number' || !Number.isInteger(${v}) || ${v} < 0 || ${v} > 4294967295) return false;`),
    int64: fixedHandler(8, writeI64, readI64, (v) => `if (typeof ${v} !== 'bigint' || ${v} < -9223372036854775808n || ${v} > 9223372036854775807n) return false;`),
    uint64: fixedHandler(8, writeU64, readU64, (v) => `if (typeof ${v} !== 'bigint' || ${v} < 0n || ${v} > 18446744073709551615n) return false;`),
    float16: fixedHandler(2, writeF16, readF16, (v) => `if (typeof ${v} !== 'number') return false;`),
    float32: fixedHandler(4, writeF32, readF32, (v) => `if (typeof ${v} !== 'number') return false;`),
    float64: fixedHandler(8, writeF64, readF64, (v) => `if (typeof ${v} !== 'number') return false;`),
    // quantize value to discrete steps, round up bits to bytes
    quantized: {
        size: (_ctx, s) => {
            const steps = Math.ceil((s.max - s.min) / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const bytes = Math.ceil(bits / 8);
            return { code: '', fixed: bytes };
        },
        pack: (ctx, s, v) => {
            const steps = Math.ceil((s.max - s.min) / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const bytes = Math.ceil(bits / 8);
            const maxVal = (1 << bits) - 1;
            const clampedVar = variable(ctx, 'clamped');
            const quantVar = variable(ctx, 'quant');
            // clamp to [min, max], then quantize to step index
            let code = `const ${clampedVar} = Math.max(${s.min}, Math.min(${s.max}, ${v}));`;
            code += `const ${quantVar} = Math.max(0, Math.min(${maxVal}, Math.round((${clampedVar} - ${s.min}) / ${s.step})));`;
            if (bytes === 1)
                code += writeU8(quantVar);
            else if (bytes === 2)
                code += writeU16(quantVar);
            else if (bytes <= 4)
                code += writeU32(quantVar);
            else
                code += writeVaruint(quantVar);
            return code;
        },
        unpack: (ctx, s, target) => {
            const steps = Math.ceil((s.max - s.min) / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const bytes = Math.ceil(bits / 8);
            const quantVar = variable(ctx, 'quant');
            let code = '';
            if (bytes === 1)
                code += readU8(quantVar);
            else if (bytes === 2)
                code += readU16(quantVar);
            else if (bytes <= 4)
                code += readU32(quantVar);
            else
                code += readVaruint(quantVar);
            // dequantize: convert step index back to value
            code += `${target} = ${s.min} + ${quantVar} * ${s.step};`;
            return code;
        },
        validate: (_ctx, s, v) => `if (typeof ${v} !== 'number' || ${v} < ${s.min} || ${v} > ${s.max}) return false;`,
    },
    // smallest-three quaternion encoding: range is -1/sqrt(2) to 1/sqrt(2)
    quat: {
        size: (_ctx, s) => {
            const steps = Math.ceil(Math.SQRT2 / s.step);
            const bits = Math.ceil(Math.log2(steps));
            // 1 byte metadata + 3 components
            let bytes = 1;
            if (bits <= 8)
                bytes += 3;
            else if (bits <= 16)
                bytes += 6;
            else
                bytes += 12;
            return { code: '', fixed: bytes };
        },
        pack: (ctx, s, v) => {
            const steps = Math.ceil(Math.SQRT2 / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const maxVal = (1 << bits) - 1;
            const scale = maxVal / Math.sqrt(2); // max component value is 1/sqrt(2)
            const qx = `${v}[0]`;
            const qy = `${v}[1]`;
            const qz = `${v}[2]`;
            const qw = `${v}[3]`;
            const ax = variable(ctx, 'ax');
            const ay = variable(ctx, 'ay');
            const az = variable(ctx, 'az');
            const aw = variable(ctx, 'aw');
            const maxIdx = variable(ctx, 'maxIdx');
            const c0 = variable(ctx, 'c0');
            const c1 = variable(ctx, 'c1');
            const c2 = variable(ctx, 'c2');
            const sign = variable(ctx, 'sign');
            let code = '';
            // find largest component by absolute value
            code += `const ${ax} = Math.abs(${qx}), ${ay} = Math.abs(${qy}), ${az} = Math.abs(${qz}), ${aw} = Math.abs(${qw});`;
            code += `let ${maxIdx} = 0;`;
            code += `if (${ay} > ${ax}) ${maxIdx} = 1;`;
            code += `if (${az} > (${maxIdx} === 0 ? ${ax} : ${ay})) ${maxIdx} = 2;`;
            code += `if (${aw} > (${maxIdx} === 0 ? ${ax} : ${maxIdx} === 1 ? ${ay} : ${az})) ${maxIdx} = 3;`;
            // get three smallest components and sign of largest
            code += `let ${c0}, ${c1}, ${c2}, ${sign};`;
            code += `if (${maxIdx} === 0) { ${c0} = ${qy}; ${c1} = ${qz}; ${c2} = ${qw}; ${sign} = ${qx} < 0 ? 1 : 0; }`;
            code += `else if (${maxIdx} === 1) { ${c0} = ${qx}; ${c1} = ${qz}; ${c2} = ${qw}; ${sign} = ${qy} < 0 ? 1 : 0; }`;
            code += `else if (${maxIdx} === 2) { ${c0} = ${qx}; ${c1} = ${qy}; ${c2} = ${qw}; ${sign} = ${qz} < 0 ? 1 : 0; }`;
            code += `else { ${c0} = ${qx}; ${c1} = ${qy}; ${c2} = ${qz}; ${sign} = ${qw} < 0 ? 1 : 0; }`;
            // quantize components
            code += `${c0} = Math.max(0, Math.min(${maxVal}, Math.round((${c0} + ${1 / Math.sqrt(2)}) * ${scale})));`;
            code += `${c1} = Math.max(0, Math.min(${maxVal}, Math.round((${c1} + ${1 / Math.sqrt(2)}) * ${scale})));`;
            code += `${c2} = Math.max(0, Math.min(${maxVal}, Math.round((${c2} + ${1 / Math.sqrt(2)}) * ${scale})));`;
            // metadata byte: 2 bits index + 1 bit sign
            code += `u8[o++] = (${maxIdx} << 1) | ${sign};`;
            if (bits <= 8) {
                code += `u8[o++] = ${c0}; u8[o++] = ${c1}; u8[o++] = ${c2};`;
            }
            else if (bits <= 16) {
                code += writeU16(c0) + writeU16(c1) + writeU16(c2);
            }
            else {
                code += writeU32(c0) + writeU32(c1) + writeU32(c2);
            }
            return code;
        },
        unpack: (ctx, s, target) => {
            const steps = Math.ceil(Math.SQRT2 / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const maxVal = (1 << bits) - 1;
            const scale = maxVal / Math.sqrt(2);
            const metaByte = variable(ctx, 'meta');
            const maxIdx = variable(ctx, 'maxIdx');
            const sign = variable(ctx, 'sign');
            const c0 = variable(ctx, 'c0'), c1 = variable(ctx, 'c1'), c2 = variable(ctx, 'c2'), c3 = variable(ctx, 'c3');
            let code = '';
            // read metadata byte (2 bits index + 1 bit sign)
            code += `const ${metaByte} = u8[o++];`;
            code += `const ${maxIdx} = ${metaByte} >> 1;`;
            code += `const ${sign} = ${metaByte} & 0x1;`;
            if (bits <= 8) {
                code += `let ${c0} = u8[o++]; let ${c1} = u8[o++]; let ${c2} = u8[o++];`;
            }
            else if (bits <= 16) {
                code += readU16(c0) + readU16(c1) + readU16(c2);
            }
            else {
                code += readU32(c0) + readU32(c1) + readU32(c2);
            }
            // dequantize
            code += `${c0} = ${c0} / ${scale} - ${1 / Math.sqrt(2)};`;
            code += `${c1} = ${c1} / ${scale} - ${1 / Math.sqrt(2)};`;
            code += `${c2} = ${c2} / ${scale} - ${1 / Math.sqrt(2)};`;
            // reconstruct largest component
            code += `let ${c3} = Math.sqrt(Math.max(0, 1 - ${c0}*${c0} - ${c1}*${c1} - ${c2}*${c2}));`;
            code += `if (${sign}) ${c3} = -${c3};`;
            // assign based on which component was dropped (as [x, y, z, w])
            code += `if (${maxIdx} === 0) ${target} = [${c3}, ${c0}, ${c1}, ${c2}];`;
            code += `else if (${maxIdx} === 1) ${target} = [${c0}, ${c3}, ${c1}, ${c2}];`;
            code += `else if (${maxIdx} === 2) ${target} = [${c0}, ${c1}, ${c3}, ${c2}];`;
            code += `else ${target} = [${c0}, ${c1}, ${c2}, ${c3}];`;
            return code;
        },
        validate: (_ctx, _s, v) => `if (!Array.isArray(${v}) || ${v}.length !== 4 || typeof ${v}[0] !== 'number' || typeof ${v}[1] !== 'number' || typeof ${v}[2] !== 'number' || typeof ${v}[3] !== 'number') return false;`,
    },
    // unit vector 2d: encode as angle, range is 0 to 2pi
    uv2: {
        size: (_ctx, s) => {
            const steps = Math.ceil((Math.PI * 2) / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const bytes = Math.ceil(bits / 8);
            return { code: '', fixed: bytes };
        },
        pack: (ctx, s, v) => {
            const steps = Math.ceil((Math.PI * 2) / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const maxVal = (1 << bits) - 1;
            const angle = variable(ctx, 'angle');
            const quantized = variable(ctx, 'quant');
            const bytes = Math.ceil(bits / 8);
            let code = '';
            // atan2 returns [-pi, pi], normalize to [0, 2pi]
            code += `let ${angle} = Math.atan2(${v}[1], ${v}[0]);`;
            code += `if (${angle} < 0) ${angle} += ${Math.PI * 2};`;
            code += `const ${quantized} = Math.round(${angle} / ${Math.PI * 2} * ${maxVal}) & ${maxVal};`;
            if (bytes === 1)
                code += writeU8(quantized);
            else if (bytes === 2)
                code += writeU16(quantized);
            else
                code += writeU32(quantized);
            return code;
        },
        unpack: (ctx, s, target) => {
            const steps = Math.ceil((Math.PI * 2) / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const maxVal = (1 << bits) - 1;
            const quantized = variable(ctx, 'quant');
            const angle = variable(ctx, 'angle');
            const bytes = Math.ceil(bits / 8);
            let code = '';
            if (bytes === 1)
                code += readU8(quantized);
            else if (bytes === 2)
                code += readU16(quantized);
            else
                code += readU32(quantized);
            code += `const ${angle} = ${quantized} / ${maxVal} * ${Math.PI * 2};`;
            code += `${target} = [Math.cos(${angle}), Math.sin(${angle})];`;
            return code;
        },
        validate: (_ctx, _s, v) => `if (!Array.isArray(${v}) || ${v}.length !== 2 || typeof ${v}[0] !== 'number' || typeof ${v}[1] !== 'number') return false;`,
    },
    // unit vector 3d: smallest-two encoding (similar to quaternion)
    uv3: {
        size: (_ctx, s) => {
            const steps = Math.ceil(Math.SQRT2 / s.step);
            const bits = Math.ceil(Math.log2(steps));
            // 2 bits for index + 1 bit for sign + (bits * 2) for components
            const totalBits = 2 + 1 + bits * 2;
            const bytes = Math.ceil(totalBits / 8);
            return { code: '', fixed: bytes };
        },
        pack: (ctx, s, v) => {
            const steps = Math.ceil(Math.SQRT2 / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const maxVal = (1 << bits) - 1;
            const scale = maxVal / Math.sqrt(2);
            const vx = `${v}[0]`;
            const vy = `${v}[1]`;
            const vz = `${v}[2]`;
            const ax = variable(ctx, 'ax');
            const ay = variable(ctx, 'ay');
            const az = variable(ctx, 'az');
            const maxIdx = variable(ctx, 'maxIdx');
            const c0 = variable(ctx, 'c0');
            const c1 = variable(ctx, 'c1');
            const sign = variable(ctx, 'sign');
            const packed = variable(ctx, 'packed');
            const totalBits = 2 + 1 + bits * 2;
            const bytes = Math.ceil(totalBits / 8);
            let code = '';
            code += `const ${ax} = Math.abs(${vx}), ${ay} = Math.abs(${vy}), ${az} = Math.abs(${vz});`;
            code += `let ${maxIdx} = 0;`;
            code += `if (${ay} > ${ax}) ${maxIdx} = 1;`;
            code += `if (${az} > (${maxIdx} === 0 ? ${ax} : ${ay})) ${maxIdx} = 2;`;
            code += `let ${c0}, ${c1}, ${sign};`;
            code += `if (${maxIdx} === 0) { ${c0} = ${vy}; ${c1} = ${vz}; ${sign} = ${vx} < 0 ? 1 : 0; }`;
            code += `else if (${maxIdx} === 1) { ${c0} = ${vx}; ${c1} = ${vz}; ${sign} = ${vy} < 0 ? 1 : 0; }`;
            code += `else { ${c0} = ${vx}; ${c1} = ${vy}; ${sign} = ${vz} < 0 ? 1 : 0; }`;
            code += `${c0} = Math.max(0, Math.min(${maxVal}, Math.round((${c0} + ${1 / Math.sqrt(2)}) * ${scale})));`;
            code += `${c1} = Math.max(0, Math.min(${maxVal}, Math.round((${c1} + ${1 / Math.sqrt(2)}) * ${scale})));`;
            code += `let ${packed} = (${maxIdx} << ${totalBits - 2}) | (${sign} << ${totalBits - 3}) | (${c0} << ${bits}) | ${c1};`;
            for (let i = bytes - 1; i >= 0; i--) {
                code += `u8[o++] = (${packed} >> ${i * 8}) & 0xFF;`;
            }
            return code;
        },
        unpack: (ctx, s, target) => {
            const steps = Math.ceil(Math.SQRT2 / s.step);
            const bits = Math.ceil(Math.log2(steps));
            const maxVal = (1 << bits) - 1;
            const scale = maxVal / Math.sqrt(2);
            const packed = variable(ctx, 'packed');
            const maxIdx = variable(ctx, 'maxIdx');
            const sign = variable(ctx, 'sign');
            const c0 = variable(ctx, 'c0');
            const c1 = variable(ctx, 'c1');
            const c2 = variable(ctx, 'c2');
            const totalBits = 2 + 1 + bits * 2;
            const bytes = Math.ceil(totalBits / 8);
            let code = '';
            code += `let ${packed} = 0;`;
            for (let i = bytes - 1; i >= 0; i--) {
                code += `${packed} |= u8[o++] << ${i * 8};`;
            }
            code += `const ${maxIdx} = (${packed} >> ${totalBits - 2}) & 0x3;`;
            code += `const ${sign} = (${packed} >> ${totalBits - 3}) & 0x1;`;
            code += `let ${c0} = (${packed} >> ${bits}) & ${maxVal};`;
            code += `let ${c1} = ${packed} & ${maxVal};`;
            code += `${c0} = ${c0} / ${scale} - ${1 / Math.sqrt(2)};`;
            code += `${c1} = ${c1} / ${scale} - ${1 / Math.sqrt(2)};`;
            code += `let ${c2} = Math.sqrt(Math.max(0, 1 - ${c0}*${c0} - ${c1}*${c1}));`;
            code += `if (${sign}) ${c2} = -${c2};`;
            code += `if (${maxIdx} === 0) ${target} = [${c2}, ${c0}, ${c1}];`;
            code += `else if (${maxIdx} === 1) ${target} = [${c0}, ${c2}, ${c1}];`;
            code += `else ${target} = [${c0}, ${c1}, ${c2}];`;
            return code;
        },
        validate: (_ctx, _s, v) => `if (!Array.isArray(${v}) || ${v}.length !== 3 || typeof ${v}[0] !== 'number' || typeof ${v}[1] !== 'number' || typeof ${v}[2] !== 'number') return false;`,
    },
    string: {
        size: (ctx, _s, v) => {
            const strVar = variable(ctx, 'str');
            const code = `const ${strVar} = ${v}; len = utf8Length(${strVar}); ${varuintSize('len')} size += len;`;
            return { code, fixed: 0 };
        },
        pack: (ctx, _s, v) => writeString(ctx, v),
        unpack: (_ctx, _s, target) => readString(target),
        validate: (_ctx, _s, v) => `if (typeof ${v} !== 'string') return false;`,
    },
    varint: {
        size: (_ctx, _s, v) => ({ code: varintSize(v), fixed: 0 }),
        pack: (_ctx, _s, v) => writeVarint(v),
        unpack: (_ctx, _s, target) => readVarint(target),
        validate: (_ctx, _s, v) => `if (typeof ${v} !== 'number' || !Number.isInteger(${v})) return false;`,
    },
    varuint: {
        size: (_ctx, _s, v) => ({ code: varuintSize(v), fixed: 0 }),
        pack: (_ctx, _s, v) => writeVaruint(v),
        unpack: (_ctx, _s, target) => readVaruint(target),
        validate: (_ctx, _s, v) => `if (typeof ${v} !== 'number' || !Number.isInteger(${v}) || ${v} < 0) return false;`,
    },
    // literals are not serialized; the known value is injected on unpack
    literal: {
        size: () => ({ code: '', fixed: 0 }),
        pack: () => '',
        unpack: (_ctx, s, target) => `${target} = ${JSON.stringify(s.value)};`,
        validate: (_ctx, s, v) => `if (${JSON.stringify(s.value)} !== ${v}) return false;`,
    },
    // enum values are mapped to varuint indices
    enumeration: {
        size: (_ctx, s, v) => {
            let inner = '';
            for (let i = 0; i < s.values.length; i++) {
                const prefix = i === 0 ? 'if' : ' else if';
                inner += `${prefix} (${v} === ${JSON.stringify(s.values[i])}) { ${varuintSize(i.toString())} }`;
            }
            inner += ` else { throw new Error('Invalid enum value: ' + ${v}); }`;
            return { code: inner, fixed: 0 };
        },
        pack: (_ctx, s, v) => {
            let inner = '';
            for (let i = 0; i < s.values.length; i++) {
                const prefix = i === 0 ? 'if' : ' else if';
                inner += `${prefix} (${v} === ${JSON.stringify(s.values[i])}) { ${writeVaruint(i.toString())} }`;
            }
            inner += ` else { throw new Error('Invalid enum value at serialize: ' + ${v}); }`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            const tag = variable(ctx, 'enumTag');
            let out = '';
            out += `let ${tag};`;
            out += readVaruint(tag);
            for (let i = 0; i < s.values.length; i++) {
                const prefix = i === 0 ? 'if' : ' else if';
                out += `${prefix} (${tag} === ${i}) { ${target} = ${JSON.stringify(s.values[i])}; }`;
            }
            out += ` else { throw new Error('Invalid enum index: ' + ${tag}); }`;
            return out;
        },
        validate: (_ctx, s, v) => {
            const checks = s.values.map((val) => `${v} === ${JSON.stringify(val)}`).join(' || ');
            return `if (!(${checks})) return false;`;
        },
    },
    // raw bytes: fixed-length (no prefix) or variable-length (varuint prefix)
    uint8Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar};`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(${v}, o); o += ${s.length};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(${v}, o); o += ${lenVar};`;
            return inner;
        },
        unpack: (_ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                return `${target} = u8.subarray(o, o + ${s.length}); o += ${s.length};`;
            }
            let inner = '';
            inner += readVaruint('len');
            inner += `${target} = u8.subarray(o, o + len); o += len;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Uint8Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // Int8Array: signed 8-bit integers, 1 byte per element
    int8Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar};`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length}), o); o += ${s.length};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar}), o); o += ${lenVar};`;
            return inner;
        },
        unpack: (_ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                return `${target} = new Int8Array(u8.buffer, u8.byteOffset + o, ${s.length}); o += ${s.length};`;
            }
            let inner = '';
            inner += readVaruint('len');
            inner += `${target} = new Int8Array(u8.buffer, u8.byteOffset + o, len); o += len;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Int8Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // Uint8ClampedArray: clamped unsigned 8-bit integers, 1 byte per element
    uint8ClampedArray: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar};`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length}), o); o += ${s.length};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar}), o); o += ${lenVar};`;
            return inner;
        },
        unpack: (_ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                return `${target} = new Uint8ClampedArray(u8.buffer, u8.byteOffset + o, ${s.length}); o += ${s.length};`;
            }
            let inner = '';
            inner += readVaruint('len');
            inner += `${target} = new Uint8ClampedArray(u8.buffer, u8.byteOffset + o, len); o += len;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Uint8ClampedArray)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // Int16Array: signed 16-bit integers, 2 bytes per element
    int16Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length * 2 };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar} * 2;`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length * 2}), o); o += ${s.length * 2};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar} * 2), o); o += ${lenVar} * 2;`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                const arrVar = variable(ctx, 'arr');
                return `const ${arrVar} = new Int16Array(${s.length}); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + ${s.length * 2})); ${target} = ${arrVar}; o += ${s.length * 2};`;
            }
            let inner = '';
            inner += readVaruint('len');
            const arrVar = variable(ctx, 'arr');
            inner += `const ${arrVar} = new Int16Array(len); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + len * 2)); ${target} = ${arrVar}; o += len * 2;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Int16Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // Uint16Array: unsigned 16-bit integers, 2 bytes per element
    uint16Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length * 2 };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar} * 2;`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length * 2}), o); o += ${s.length * 2};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar} * 2), o); o += ${lenVar} * 2;`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                const arrVar = variable(ctx, 'arr');
                return `const ${arrVar} = new Uint16Array(${s.length}); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + ${s.length * 2})); ${target} = ${arrVar}; o += ${s.length * 2};`;
            }
            let inner = '';
            inner += readVaruint('len');
            const arrVar = variable(ctx, 'arr');
            inner += `const ${arrVar} = new Uint16Array(len); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + len * 2)); ${target} = ${arrVar}; o += len * 2;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Uint16Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // Int32Array: signed 32-bit integers, 4 bytes per element
    int32Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length * 4 };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar} * 4;`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length * 4}), o); o += ${s.length * 4};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar} * 4), o); o += ${lenVar} * 4;`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                const arrVar = variable(ctx, 'arr');
                return `const ${arrVar} = new Int32Array(${s.length}); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + ${s.length * 4})); ${target} = ${arrVar}; o += ${s.length * 4};`;
            }
            let inner = '';
            inner += readVaruint('len');
            const arrVar = variable(ctx, 'arr');
            inner += `const ${arrVar} = new Int32Array(len); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + len * 4)); ${target} = ${arrVar}; o += len * 4;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Int32Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // Uint32Array: unsigned 32-bit integers, 4 bytes per element
    uint32Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length * 4 };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar} * 4;`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length * 4}), o); o += ${s.length * 4};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar} * 4), o); o += ${lenVar} * 4;`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                const arrVar = variable(ctx, 'arr');
                return `const ${arrVar} = new Uint32Array(${s.length}); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + ${s.length * 4})); ${target} = ${arrVar}; o += ${s.length * 4};`;
            }
            let inner = '';
            inner += readVaruint('len');
            const arrVar = variable(ctx, 'arr');
            inner += `const ${arrVar} = new Uint32Array(len); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + len * 4)); ${target} = ${arrVar}; o += len * 4;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Uint32Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // Float32Array: 32-bit floating point, 4 bytes per element
    float32Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length * 4 };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar} * 4;`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length * 4}), o); o += ${s.length * 4};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar} * 4), o); o += ${lenVar} * 4;`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                const arrVar = variable(ctx, 'arr');
                return `const ${arrVar} = new Float32Array(${s.length}); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + ${s.length * 4})); ${target} = ${arrVar}; o += ${s.length * 4};`;
            }
            let inner = '';
            inner += readVaruint('len');
            const arrVar = variable(ctx, 'arr');
            inner += `const ${arrVar} = new Float32Array(len); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + len * 4)); ${target} = ${arrVar}; o += len * 4;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Float32Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // Float64Array: 64-bit floating point, 8 bytes per element
    float64Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length * 8 };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar} * 8;`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length * 8}), o); o += ${s.length * 8};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar} * 8), o); o += ${lenVar} * 8;`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                const arrVar = variable(ctx, 'arr');
                return `const ${arrVar} = new Float64Array(${s.length}); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + ${s.length * 8})); ${target} = ${arrVar}; o += ${s.length * 8};`;
            }
            let inner = '';
            inner += readVaruint('len');
            const arrVar = variable(ctx, 'arr');
            inner += `const ${arrVar} = new Float64Array(len); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + len * 8)); ${target} = ${arrVar}; o += len * 8;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof Float64Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // BigInt64Array: signed 64-bit BigInt, 8 bytes per element
    bigInt64Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length * 8 };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar} * 8;`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length * 8}), o); o += ${s.length * 8};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar} * 8), o); o += ${lenVar} * 8;`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                const arrVar = variable(ctx, 'arr');
                return `const ${arrVar} = new BigInt64Array(${s.length}); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + ${s.length * 8})); ${target} = ${arrVar}; o += ${s.length * 8};`;
            }
            let inner = '';
            inner += readVaruint('len');
            const arrVar = variable(ctx, 'arr');
            inner += `const ${arrVar} = new BigInt64Array(len); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + len * 8)); ${target} = ${arrVar}; o += len * 8;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof BigInt64Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // BigUint64Array: unsigned 64-bit BigInt, 8 bytes per element
    bigUint64Array: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return { code: '', fixed: s.length * 8 };
            }
            const lenVar = variable(ctx, 'len');
            return { code: `const ${lenVar} = ${v}.length; ${varuintSize(lenVar)} size += ${lenVar} * 8;`, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                return `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${s.length * 8}), o); o += ${s.length * 8};`;
            }
            const lenVar = variable(ctx, 'len');
            let inner = '';
            inner += `const ${lenVar} = ${v}.length;`;
            inner += writeVaruint(lenVar);
            inner += `u8.set(new Uint8Array(${v}.buffer, ${v}.byteOffset, ${lenVar} * 8), o); o += ${lenVar} * 8;`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                const arrVar = variable(ctx, 'arr');
                return `const ${arrVar} = new BigUint64Array(${s.length}); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + ${s.length * 8})); ${target} = ${arrVar}; o += ${s.length * 8};`;
            }
            let inner = '';
            inner += readVaruint('len');
            const arrVar = variable(ctx, 'arr');
            inner += `const ${arrVar} = new BigUint64Array(len); new Uint8Array(${arrVar}.buffer).set(u8.subarray(o, o + len * 8)); ${target} = ${arrVar}; o += len * 8;`;
            return inner;
        },
        validate: (_ctx, s, v) => {
            let inner = `if (!(${v} instanceof BigUint64Array)) return false;`;
            if ('length' in s && typeof s.length === 'number') {
                inner += ` if (${v}.length !== ${s.length}) return false;`;
            }
            return inner;
        },
    },
    // fixed-length lists omit the length prefix; variable-length use varuint
    // booleans are bitpacked (8 per byte)
    list: {
        size: (ctx, s, v) => {
            if ('length' in s && typeof s.length === 'number') {
                if (s.of.type === 'boolean') {
                    return { code: '', fixed: Math.ceil(s.length / 8) };
                }
                const i = variable(ctx, 'i');
                const elem = size(ctx, s.of, `${v}[${i}]`);
                if (elem.code === '' && elem.fixed > 0) {
                    return { code: '', fixed: elem.fixed * s.length };
                }
                const inner = `for (let ${i} = 0; ${i} < ${s.length}; ${i}++) { ${elem.code} }`;
                return { code: inner, fixed: 0 };
            }
            else {
                const i = variable(ctx, 'i');
                const lenVar = variable(ctx, 'len');
                if (s.of.type === 'boolean') {
                    let parts = '';
                    parts += `const ${lenVar} = ${v}.length;`;
                    parts += varuintSize(lenVar);
                    const bytesVar = variable(ctx, 'bytes');
                    parts += `const ${bytesVar} = Math.ceil(${lenVar} / 8); size += ${bytesVar};`;
                    return { code: parts, fixed: 0 };
                }
                const elem = size(ctx, s.of, `${v}[${i}]`);
                let parts = '';
                parts += `const ${lenVar} = ${v}.length;`;
                parts += varuintSize(lenVar);
                if (elem.fixed > 0)
                    parts += `size += ${elem.fixed} * ${lenVar};`;
                if (elem.code && elem.code !== '') {
                    parts += `for (let ${i} = 0; ${i} < ${lenVar}; ${i}++) { ${elem.code} }`;
                }
                return { code: parts, fixed: 0 };
            }
        },
        pack: (ctx, s, v) => {
            if (s.length !== undefined) {
                if (s.of.type === 'boolean') {
                    const boolRefs = Array.from({ length: s.length }, (_, i) => ({ varRef: `${v}[${i}]` }));
                    return emitBitPack(ctx, boolRefs);
                }
                let inner = '';
                for (let i = 0; i < s.length; i++) {
                    inner += pack(ctx, s.of, `${v}[${i}]`);
                }
                return inner;
            }
            else {
                if (s.of.type === 'boolean') {
                    const lenVar = variable(ctx, 'len');
                    let inner = '';
                    inner += `const ${lenVar} = ${v}.length;`;
                    inner += writeVaruint(lenVar);
                    const byteVar = variable(ctx, 'byte');
                    const bIdx = variable(ctx, 'bIdx');
                    const bitIdx = variable(ctx, 'bitIdx');
                    inner += `for (let ${bIdx} = 0; ${bIdx} < Math.ceil(${lenVar} / 8); ${bIdx}++) {`;
                    inner += `let ${byteVar} = 0;`;
                    inner += `for (let bit = 0; bit < 8; bit++) {`;
                    inner += `const ${bitIdx} = ${bIdx} * 8 + bit;`;
                    inner += `if (${bitIdx} >= ${lenVar}) break;`;
                    inner += `if (${v}[${bitIdx}]) ${byteVar} |= (1 << bit);`;
                    inner += `}`;
                    inner += `u8[o++] = ${byteVar};`;
                    inner += `}`;
                    return inner;
                }
                const i = variable(ctx, 'i');
                const lenVar = variable(ctx, 'len');
                let inner = '';
                inner += `const ${lenVar} = ${v}.length;`;
                inner += writeVaruint(lenVar);
                inner += `for (let ${i} = 0; ${i} < ${lenVar}; ${i}++) {`;
                inner += pack(ctx, s.of, `${v}[${i}]`);
                inner += '}';
                return inner;
            }
        },
        unpack: (ctx, s, target) => {
            if ('length' in s && typeof s.length === 'number') {
                if (s.of.type === 'boolean') {
                    let inner = `${target} = new Array(${s.length});`;
                    const boolTargets = Array.from({ length: s.length }, (_, i) => ({ target: `${target}[${i}]` }));
                    inner += emitBitUnpack(ctx, boolTargets);
                    return inner;
                }
                let inner = `${target} = new Array(${s.length});`;
                for (let i = 0; i < s.length; i++) {
                    inner += unpack(ctx, s.of, `${target}[${i}]`);
                }
                return inner;
            }
            else {
                if (s.of.type === 'boolean') {
                    const l = variable(ctx, 'l');
                    let inner = '';
                    inner += `let ${l};`;
                    inner += readVaruint(l);
                    inner += `${target} = new Array(${l});`;
                    const bIdx = variable(ctx, 'bIdx');
                    const bitIdx = variable(ctx, 'bitIdx');
                    const byteIdx = variable(ctx, 'bval');
                    inner += `for (let ${bIdx} = 0; ${bIdx} < Math.ceil(${l} / 8); ${bIdx}++) {`;
                    inner += `const ${byteIdx} = u8[o++];`;
                    inner += `for (let bit = 0; bit < 8; bit++) {`;
                    inner += `const ${bitIdx} = ${bIdx} * 8 + bit;`;
                    inner += `if (${bitIdx} >= ${l}) break;`;
                    inner += `${target}[${bitIdx}] = (${byteIdx} & (1 << bit)) !== 0;`;
                    inner += `}`;
                    inner += `}`;
                    return inner;
                }
                const i = variable(ctx, 'i');
                const l = variable(ctx, 'l');
                let inner = '';
                inner += `let ${l};`;
                inner += readVaruint(l);
                inner += `${target} = new Array(${l});`;
                inner += `for (let ${i} = 0; ${i} < ${l}; ${i}++) {`;
                inner += unpack(ctx, s.of, `${target}[${i}]`);
                inner += `}`;
                return inner;
            }
        },
        validate: (ctx, s, v) => {
            if (s.length !== undefined) {
                let inner = '';
                inner += `if (!Array.isArray(${v})) return false;`;
                inner += `if (${v}.length !== ${s.length}) return false;`;
                for (let i = 0; i < s.length; i++) {
                    inner += validate(ctx, s.of, `${v}[${i}]`);
                }
                return inner;
            }
            else {
                const i = variable(ctx, 'i');
                let inner = '';
                inner += `if (!Array.isArray(${v})) return false;`;
                inner += `for (let ${i} = 0; ${i} < ${v}.length; ${i}++) {`;
                inner += validate(ctx, s.of, `${v}[${i}]`);
                inner += '}';
                return inner;
            }
        },
    },
    // booleans are separated and bitpacked, non-booleans written in order
    tuple: {
        size: (ctx, s, v) => {
            let fixed = 0;
            const parts = [];
            const indexed = s.of.map((schema, i) => ({ schema, i }));
            const [bools, nonBools] = partition(indexed, (x) => x.schema.type === 'boolean');
            if (bools.length > 0)
                fixed += Math.ceil(bools.length / 8);
            for (const { schema, i } of nonBools) {
                const child = size(ctx, schema, `${v}[${i}]`);
                fixed += child.fixed;
                if (child.code !== '')
                    parts.push(child.code);
            }
            return { code: parts.join(' '), fixed };
        },
        pack: (ctx, s, v) => {
            let out = '';
            const indexed = s.of.map((schema, i) => ({ schema, i }));
            const [bools, nonBools] = partition(indexed, (x) => x.schema.type === 'boolean');
            if (bools.length > 0) {
                out += emitBitPack(ctx, bools.map((x) => ({ varRef: `${v}[${x.i}]` })));
            }
            for (const { schema, i } of nonBools) {
                out += pack(ctx, schema, `${v}[${i}]`);
            }
            return out;
        },
        unpack: (ctx, s, target) => {
            let inner = `${target} = new Array(${s.of.length});`;
            const indexed = s.of.map((schema, i) => ({ schema, i }));
            const [bools, nonBools] = partition(indexed, (x) => x.schema.type === 'boolean');
            if (bools.length > 0) {
                inner += emitBitUnpack(ctx, bools.map((x) => ({ target: `${target}[${x.i}]` })));
            }
            for (const { schema, i } of nonBools) {
                inner += unpack(ctx, schema, `${target}[${i}]`);
            }
            return inner;
        },
        validate: (ctx, s, v) => {
            let inner = '';
            inner += `if (!Array.isArray(${v})) return false;`;
            inner += `if (${v}.length !== ${s.of.length}) return false;`;
            for (let i = 0; i < s.of.length; i++) {
                inner += validate(ctx, s.of[i], `${v}[${i}]`);
            }
            return inner;
        },
    },
    // keys are sorted for deterministic order; booleans bitpacked separately
    object: {
        size: (ctx, s, v) => {
            let fixed = 0;
            const parts = [];
            const sortedKeys = Object.keys(s.fields).sort();
            const [boolKeys, nonBoolKeys] = partition(sortedKeys, (k) => s.fields[k].type === 'boolean');
            if (boolKeys.length > 0)
                fixed += Math.ceil(boolKeys.length / 8);
            for (const k of nonBoolKeys) {
                const child = size(ctx, s.fields[k], `${v}[${JSON.stringify(k)}]`);
                fixed += child.fixed;
                if (child.code !== '')
                    parts.push(child.code);
            }
            return { code: parts.join(' '), fixed };
        },
        pack: (ctx, s, v) => {
            let out = '';
            const sortedKeys = Object.keys(s.fields).sort();
            const [boolKeys, nonBoolKeys] = partition(sortedKeys, (k) => s.fields[k].type === 'boolean');
            if (boolKeys.length > 0) {
                out += emitBitPack(ctx, boolKeys.map((k) => ({ varRef: `${v}[${JSON.stringify(k)}]` })));
            }
            for (const k of nonBoolKeys) {
                out += pack(ctx, s.fields[k], `${v}[${JSON.stringify(k)}]`);
            }
            return out;
        },
        unpack: (ctx, s, target) => {
            let inner = `${target} = {};`;
            const sortedKeys = Object.keys(s.fields).sort();
            const [boolKeys, nonBoolKeys] = partition(sortedKeys, (k) => s.fields[k].type === 'boolean');
            if (boolKeys.length > 0) {
                inner += emitBitUnpack(ctx, boolKeys.map((k) => ({ target: `${target}[${JSON.stringify(k)}]` })));
            }
            for (const key of nonBoolKeys) {
                inner += unpack(ctx, s.fields[key], `${target}[${JSON.stringify(key)}]`);
            }
            return inner;
        },
        validate: (ctx, s, v) => {
            let inner = '';
            inner += `if (typeof (${v}) !== "object") return false;`;
            const sortedKeys = Object.keys(s.fields).sort();
            for (const k of sortedKeys) {
                const key = JSON.stringify(k);
                inner += `if (!(${key} in ${v})) return false;`;
                inner += validate(ctx, s.fields[k], `${v}[${key}]`);
            }
            return inner;
        },
    },
    // varuint key count, then all keys (as strings), then all values
    // boolean values are bitpacked; keys accessed by index for value lookup
    record: {
        size: (ctx, s, v) => {
            const i = variable(ctx, 'i');
            const keys = variable(ctx, 'keys');
            const keysLen = variable(ctx, 'keysLen');
            let inner = '';
            inner += `if (${v} && typeof ${v} === 'object') {`;
            inner += `const ${keys} = Object.keys(${v});`;
            inner += `const ${keysLen} = ${keys}.length;`;
            inner += `${varuintSize(keysLen)}`;
            const strVar = variable(ctx, 'str');
            inner += `for (let ${i} = 0; ${i} < ${keysLen}; ${i}++) { const k = ${keys}[${i}]; const ${strVar} = k; len = utf8Length(${strVar}); ${varuintSize('len')} size += len; }`;
            if (s.field.type === 'boolean') {
                const bytesVar = variable(ctx, 'bytes');
                inner += `const ${bytesVar} = Math.ceil(${keysLen} / 8); size += ${bytesVar};`;
            }
            else {
                const childSize = size(ctx, s.field, `${v}[k]`);
                if (childSize.fixed > 0)
                    inner += ` size += ${childSize.fixed} * ${keysLen}; `;
                if (childSize.code !== '') {
                    const i2 = variable(ctx, 'i');
                    inner += `for (let ${i2} = 0; ${i2} < ${keysLen}; ${i2}++) { const k = ${keys}[${i2}]; ${childSize.code} }`;
                }
            }
            inner += `}`;
            return { code: inner, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            const i = variable(ctx, 'i');
            const keys = variable(ctx, 'keys');
            const keysLen = variable(ctx, 'keysLen');
            const keyVar = variable(ctx, 'key');
            let inner = '';
            inner += `${keys} = Object.keys(${v});`;
            inner += `${keysLen} = ${keys}.length;`;
            inner += writeVaruint(keysLen);
            inner += `for (let ${i} = 0; ${i} < ${keysLen}; ${i}++) {`;
            inner += `const ${keyVar} = ${keys}[${i}];`;
            inner += writeString(ctx, keyVar);
            inner += `}`;
            if (s.field.type === 'boolean') {
                const valIdx = variable(ctx, 'valIdx');
                const byteVar = variable(ctx, 'byte');
                inner += `{`;
                inner += `let ${byteVar};`;
                inner += `for (let ${valIdx} = 0; ${valIdx} < Math.ceil(${keysLen} / 8); ${valIdx}++) {`;
                inner += `${byteVar} = 0;`;
                inner += `for (let bit = 0; bit < 8; bit++) {`;
                inner += `const idx = ${valIdx} * 8 + bit;`;
                inner += `if (idx >= ${keysLen}) break;`;
                inner += `if (${v}[${keys}[idx]]) ${byteVar} |= (1 << bit);`;
                inner += `}`;
                inner += `u8[o++] = ${byteVar};`;
                inner += `}`;
                inner += `}`;
            }
            else {
                const valIdx = variable(ctx, 'valIdx');
                const valVar = variable(ctx, 'val');
                inner += `for (let ${valIdx} = 0; ${valIdx} < ${keysLen}; ${valIdx}++) {`;
                inner += `const ${valVar} = ${v}[${keys}[${valIdx}]];`;
                inner += pack(ctx, s.field, valVar);
                inner += `}`;
            }
            return inner;
        },
        unpack: (ctx, s, target) => {
            const i = variable(ctx, 'i');
            const k = variable(ctx, 'k');
            const count = variable(ctx, 'count');
            const keys = variable(ctx, 'keys');
            let inner = '';
            inner += `let ${count};`;
            inner += readVaruint(count);
            inner += `${target} = {};`;
            inner += `const ${keys} = new Array(${count});`;
            inner += `for (let ${i} = 0; ${i} < ${count}; ${i}++) { `;
            inner += `let ${k};`;
            inner += readString(k);
            inner += `${keys}[${i}] = ${k};`;
            inner += `}`;
            if (s.field.type === 'boolean') {
                const byteIdx = variable(ctx, 'bval');
                const valIdx = variable(ctx, 'valIdx');
                inner += `{`;
                inner += `for (let ${valIdx} = 0; ${valIdx} < Math.ceil(${count} / 8); ${valIdx}++) {`;
                inner += `const ${byteIdx} = u8[o++];`;
                inner += `for (let bit = 0; bit < 8; bit++) {`;
                inner += `const idx = ${valIdx} * 8 + bit;`;
                inner += `if (idx >= ${count}) break;`;
                inner += `${target}[${keys}[idx]] = (${byteIdx} & (1 << bit)) !== 0;`;
                inner += `}`;
                inner += `}`;
                inner += `}`;
            }
            else {
                const valIdx = variable(ctx, 'valIdx');
                inner += `for (let ${valIdx} = 0; ${valIdx} < ${count}; ${valIdx}++) { `;
                inner += unpack(ctx, s.field, `${target}[${keys}[${valIdx}]]`);
                inner += `}`;
            }
            return inner;
        },
        validate: (ctx, s, v) => {
            const i = variable(ctx, 'i');
            const keys = variable(ctx, 'keys');
            let inner = '';
            inner += `if (typeof (${v}) !== "object") return false;`;
            inner += `${keys} = Object.keys(${v});`;
            inner += `for (let ${i} = 0; ${i} < ${keys}.length; ${i}++) {`;
            inner += validate(ctx, s.field, `${v}[${keys}[${i}]]`);
            inner += `}`;
            return inner;
        },
    },
    // 1-byte flag: 0 = null, 1 = present
    nullable: {
        size: (ctx, s, v) => {
            const child = size(ctx, s.of, v);
            let inner = '';
            inner += `if (${v} !== null) {`;
            inner += child.code;
            inner += `size += ${child.fixed};`;
            inner += `}`;
            return { code: inner, fixed: 1 };
        },
        pack: (ctx, s, v) => {
            let inner = '';
            inner += `if (${v} === null) {`;
            inner += `u8[o++] = 0;`;
            inner += `} else {`;
            inner += `u8[o++] = 1;`;
            inner += pack(ctx, s.of, v);
            inner += `}`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            const flag = variable(ctx, 'flag');
            let inner = '';
            inner += `const ${flag} = u8[o++];`;
            inner += `if (${flag} === 0) {`;
            inner += `${target} = null;`;
            inner += `} else {`;
            inner += unpack(ctx, s.of, target);
            inner += `}`;
            return inner;
        },
        validate: (ctx, s, v) => {
            let inner = '';
            inner += `if (${v} === null) return true;`;
            inner += validate(ctx, s.of, v);
            return inner;
        },
    },
    // 1-byte flag: 0 = undefined, 1 = present
    optional: {
        size: (ctx, s, v) => {
            const child = size(ctx, s.of, v);
            let inner = '';
            inner += `if (${v} !== undefined) {`;
            inner += child.code;
            inner += `size += ${child.fixed};`;
            inner += `}`;
            return { code: inner, fixed: 1 };
        },
        pack: (ctx, s, v) => {
            let inner = '';
            inner += `if (${v} === undefined) {`;
            inner += `u8[o++] = 0;`;
            inner += `} else {`;
            inner += `u8[o++] = 1;`;
            inner += pack(ctx, s.of, v);
            inner += `}`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            const flag = variable(ctx, 'flag');
            let inner = '';
            inner += `const ${flag} = u8[o++];`;
            inner += `if (${flag} === 1) {`;
            inner += unpack(ctx, s.of, target);
            inner += `}`;
            return inner;
        },
        validate: (ctx, s, v) => {
            let inner = '';
            inner += `if (${v} === undefined) return true;`;
            inner += validate(ctx, s.of, v);
            return inner;
        },
    },
    // 1-byte flag: 0 = null, 1 = undefined, 2 = present
    nullish: {
        size: (ctx, s, v) => {
            const child = size(ctx, s.of, v);
            let inner = '';
            inner += `if (${v} !== null && ${v} !== undefined) {`;
            inner += child.code;
            inner += `size += ${child.fixed};`;
            inner += `}`;
            return { code: inner, fixed: 1 };
        },
        pack: (ctx, s, v) => {
            let inner = '';
            inner += `if (${v} === null) {`;
            inner += `u8[o++] = 0;`;
            inner += `} else if (${v} === undefined) {`;
            inner += `u8[o++] = 1;`;
            inner += `} else {`;
            inner += `u8[o++] = 2;`;
            inner += pack(ctx, s.of, v);
            inner += `}`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            const flag = variable(ctx, 'flag');
            let inner = '';
            inner += `const ${flag} = u8[o++];`;
            inner += `if (${flag} === 0) {`;
            inner += `${target} = null;`;
            inner += `} else if (${flag} === 2) {`;
            inner += unpack(ctx, s.of, target);
            inner += `}`;
            return inner;
        },
        validate: (ctx, s, v) => {
            let inner = '';
            inner += `if (${v} === null || ${v} === undefined) return true;`;
            inner += validate(ctx, s.of, v);
            return inner;
        },
    },
    // discriminated union: varuint tag selects variant, discriminant field must be a literal
    union: {
        size: (ctx, s, v) => {
            const keyVar = variable(ctx, 'keyVal');
            let inner = '';
            inner += `const ${keyVar} = ${v}[${JSON.stringify(s.key)}];`;
            for (let i = 0; i < s.variants.length; i++) {
                const variant = s.variants[i];
                const disc = variant.fields[s.key];
                if (disc.type !== 'literal') {
                    throw new Error('Union discriminant must be a literal in every variant');
                }
                const discriminant = disc.value;
                const elem = size(ctx, variant, v);
                inner += ` ${i !== 0 ? 'else' : ''} if (${keyVar} === ${JSON.stringify(discriminant)}) { ${varuintSize(i.toString())} size += ${elem.fixed}; ${elem.code} }`;
            }
            inner += ` else { throw new Error('Invalid discriminant for union key: ' + ${keyVar}); }`;
            return { code: inner, fixed: 0 };
        },
        pack: (ctx, s, v) => {
            const discriminant = variable(ctx, 'discriminant');
            let inner = '';
            inner += `const ${discriminant} = ${v}[${JSON.stringify(s.key)}];`;
            for (let i = 0; i < s.variants.length; i++) {
                const variant = s.variants[i];
                const disc = variant.fields[s.key];
                if (!disc || disc.type !== 'literal') {
                    throw new Error('Union discriminant must be a literal in every variant');
                }
                const lit = disc.value;
                if (i === 0) {
                    inner += `if (${discriminant} === ${JSON.stringify(lit)}) { ${writeVaruint(i.toString())} ${pack(ctx, variant, v)} }`;
                }
                else {
                    inner += ` else if (${discriminant} === ${JSON.stringify(lit)}) { ${writeVaruint(i.toString())} ${pack(ctx, variant, v)} }`;
                }
            }
            inner += ` else { throw new Error('Invalid discriminant for union key at serialize: ' + ${discriminant}); }`;
            return inner;
        },
        unpack: (ctx, s, target) => {
            const tag = variable(ctx, 'tag');
            let out = '';
            out += `let ${tag};`;
            out += readVaruint(tag);
            out += `${target} = {};`;
            out += `switch (${tag}) {`;
            for (let i = 0; i < s.variants.length; i++) {
                out += `case ${i}: `;
                out += unpack(ctx, s.variants[i], target);
                out += ` break;`;
            }
            out += `default: throw new Error('Invalid union tag: ' + ${tag});`;
            out += `}`;
            return out;
        },
        validate: (ctx, s, v) => {
            let inner = '';
            inner += `if (typeof (${v}) !== "object") return false;`;
            const keyVar = variable(ctx, 'key');
            inner += `const ${keyVar} = ${v}[${JSON.stringify(s.key)}];`;
            let first = true;
            for (let i = 0; i < s.variants.length; i++) {
                const variant = s.variants[i];
                const disc = variant.fields[s.key];
                if (!disc || disc.type !== 'literal') {
                    throw new Error('Union discriminant must be a literal in every variant');
                }
                const lit = disc.value;
                if (first) {
                    inner += `if (${keyVar} === ${JSON.stringify(lit)}) {`;
                    first = false;
                }
                else {
                    inner += ` else if (${keyVar} === ${JSON.stringify(lit)}) {`;
                }
                inner += validate(ctx, variant, v);
                inner += ` }`;
            }
            inner += ` else { return false; }`;
            return inner;
        },
    },
};
/* read/write utils */
function varuintSize(value) {
    return `vuint = ${value} >>> 0; while (vuint > 127) { size++; vuint >>>= 7; } size += 1;`;
}
function writeVaruint(value, offset = 'o') {
    return `vuint = ${value} >>> 0; while (vuint > 127) { u8[${offset}++] = (vuint & 127) | 128; vuint >>>= 7; } u8[${offset}++] = vuint & 127;`;
}
function readVaruint(target, offset = 'o') {
    let code = '';
    code += `val = 0; shift = 0; byte = 0;`;
    code += `do { byte = u8[${offset}++]; val |= (byte & 0x7f) << shift; shift += 7; } while ((byte & 0x80) !== 0);`;
    code += `${target} = val >>> 0;`;
    return code;
}
// zigzag encoding: map signed to unsigned so small negatives are small too
function varintSize(value) {
    return `vint = ((${value} << 1) ^ (${value} >> 31)) >>> 0; ${varuintSize('vint')}`;
}
function writeVarint(value, offset = 'o') {
    return `vint = (${value} << 1) ^ (${value} >> 31); ${writeVaruint('vint', offset)}`;
}
function readVarint(target, offset = 'o') {
    let code = readVaruint('val', offset);
    code += `${target} = (val >>> 1) ^ -(val & 1);`;
    return code;
}
function readBool(target, offset = 'o') {
    return `${target} = u8[${offset}++] !== 0;`;
}
function writeBool(value, offset = 'o') {
    return `u8[${offset}++] = ${value} ? 1 : 0;`;
}
// shift left then arithmetic shift right to sign-extend
function readI8(target, offset = 'o') {
    return `${target} = (u8[${offset}++] << 24) >> 24;`;
}
function writeI8(value, offset = 'o') {
    return `u8[${offset}++] = ${value};`;
}
function readU8(target, offset = 'o') {
    return `${target} = u8[${offset}++];`;
}
function writeU8(value, offset = 'o') {
    return `u8[${offset}++] = ${value} & 0xff;`;
}
function readI16(target, offset = 'o') {
    return `val = u8[${offset}++] | (u8[${offset}++] << 8); ${target} = (val << 16) >> 16;`;
}
function writeI16(value, offset = 'o') {
    return `val = ${value} & 0xffff; u8[${offset}++] = val & 0xff; u8[${offset}++] = (val >> 8) & 0xff;`;
}
function readU16(target, offset = 'o') {
    return `val = u8[${offset}++] | (u8[${offset}++] << 8); ${target} = val & 0xffff;`;
}
function writeU16(value, offset = 'o') {
    return `val = ${value} & 0xffff; u8[${offset}++] = val & 0xff; u8[${offset}++] = (val >> 8) & 0xff;`;
}
function readI32(target, offset = 'o') {
    return `val = (u8[${offset}++] | (u8[${offset}++] << 8) | (u8[${offset}++] << 16) | (u8[${offset}++] << 24)) | 0; ${target} = val | 0;`;
}
function writeI32(value, offset = 'o') {
    return `val = ${value} | 0; u8[${offset}++] = val & 0xff; u8[${offset}++] = (val >> 8) & 0xff; u8[${offset}++] = (val >> 16) & 0xff; u8[${offset}++] = (val >> 24) & 0xff;`;
}
function readU32(target, offset = 'o') {
    return `${target} = (u8[${offset}++] | (u8[${offset}++] << 8) | (u8[${offset}++] << 16) | (u8[${offset}++] << 24)) >>> 0;`;
}
function writeU32(value, offset = 'o') {
    return `val = ${value} >>> 0; u8[${offset}++] = val & 0xff; u8[${offset}++] = (val >> 8) & 0xff; u8[${offset}++] = (val >> 16) & 0xff; u8[${offset}++] = (val >> 24) & 0xff;`;
}
function readI64(target, offset = 'o') {
    let code = '';
    code += `i64_u8[0] = u8[${offset}++]; i64_u8[1] = u8[${offset}++]; i64_u8[2] = u8[${offset}++]; i64_u8[3] = u8[${offset}++];`;
    code += `i64_u8[4] = u8[${offset}++]; i64_u8[5] = u8[${offset}++]; i64_u8[6] = u8[${offset}++]; i64_u8[7] = u8[${offset}++];`;
    code += `${target} = i64[0];`;
    return code;
}
function writeI64(value, offset = 'o') {
    let code = '';
    code += `i64[0] = ${value};`;
    code += `u8[${offset}++] = i64_u8[0]; u8[${offset}++] = i64_u8[1]; u8[${offset}++] = i64_u8[2]; u8[${offset}++] = i64_u8[3];`;
    code += `u8[${offset}++] = i64_u8[4]; u8[${offset}++] = i64_u8[5]; u8[${offset}++] = i64_u8[6]; u8[${offset}++] = i64_u8[7];`;
    return code;
}
function readU64(target, offset = 'o') {
    let code = '';
    code += `u64_u8[0] = u8[${offset}++]; u64_u8[1] = u8[${offset}++]; u64_u8[2] = u8[${offset}++]; u64_u8[3] = u8[${offset}++];`;
    code += `u64_u8[4] = u8[${offset}++]; u64_u8[5] = u8[${offset}++]; u64_u8[6] = u8[${offset}++]; u64_u8[7] = u8[${offset}++];`;
    code += `${target} = u64[0];`;
    return code;
}
function writeU64(value, offset = 'o') {
    let code = '';
    code += `u64[0] = ${value};`;
    code += `u8[${offset}++] = u64_u8[0]; u8[${offset}++] = u64_u8[1]; u8[${offset}++] = u64_u8[2]; u8[${offset}++] = u64_u8[3];`;
    code += `u8[${offset}++] = u64_u8[4]; u8[${offset}++] = u64_u8[5]; u8[${offset}++] = u64_u8[6]; u8[${offset}++] = u64_u8[7];`;
    return code;
}
function readF16(target, offset = 'o') {
    let code = '';
    code += `f16_u8[0] = u8[${offset}++]; f16_u8[1] = u8[${offset}++];`;
    code += `${target} = f16[0];`;
    return code;
}
function writeF16(value, offset = 'o') {
    let code = '';
    code += `f16[0] = ${value};`;
    code += `u8[${offset}++] = f16_u8[0]; u8[${offset}++] = f16_u8[1];`;
    return code;
}
function readF32(target, offset = 'o') {
    let code = '';
    code += `f32_u8[0] = u8[${offset}++]; f32_u8[1] = u8[${offset}++]; f32_u8[2] = u8[${offset}++]; f32_u8[3] = u8[${offset}++];`;
    code += `${target} = f32[0];`;
    return code;
}
function writeF32(value, offset = 'o') {
    let code = '';
    code += `f32[0] = ${value};`;
    code += `u8[${offset}++] = f32_u8[0]; u8[${offset}++] = f32_u8[1]; u8[${offset}++] = f32_u8[2]; u8[${offset}++] = f32_u8[3];`;
    return code;
}
function readF64(target, offset = 'o') {
    let code = '';
    code += `f64_u8[0] = u8[${offset}++]; f64_u8[1] = u8[${offset}++]; f64_u8[2] = u8[${offset}++]; f64_u8[3] = u8[${offset}++];`;
    code += `f64_u8[4] = u8[${offset}++]; f64_u8[5] = u8[${offset}++]; f64_u8[6] = u8[${offset}++]; f64_u8[7] = u8[${offset}++];`;
    code += `${target} = f64[0];`;
    return code;
}
function writeF64(value, offset = 'o') {
    let code = '';
    code += `f64[0] = ${value};`;
    code += `u8[${offset}++] = f64_u8[0]; u8[${offset}++] = f64_u8[1]; u8[${offset}++] = f64_u8[2]; u8[${offset}++] = f64_u8[3];`;
    code += `u8[${offset}++] = f64_u8[4]; u8[${offset}++] = f64_u8[5]; u8[${offset}++] = f64_u8[6]; u8[${offset}++] = f64_u8[7];`;
    return code;
}
function readString(target, offset = 'o') {
    let code = '';
    code += readVaruint('len', offset);
    code += `${target} = len === 0 ? '' : textDecoder.decode(u8.subarray(${offset}, ${offset} + len)); ${offset} += len;`;
    return code;
}
function writeString(ctx, value, offset = 'o') {
    let code = '';
    const strVar = variable(ctx, 'str');
    code += `const ${strVar} = ${value};`;
    code += `len = utf8Length(${strVar});`;
    code += writeVaruint('len', offset);
    code += `textEncoder.encodeInto(${strVar}, u8.subarray(${offset}));`;
    code += `${offset} += len;`;
    return code;
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
// notify frames carry a packcat-encoded NotifyMessage payload. the tcp channel
// additionally sends one raw frame first: the utf-8 auth token.
// --- message schema ---
const ProcessMetrics = object({
    memoryRss: float64(),
    memoryHeapUsed: float64(),
    memoryHeapTotal: float64(),
    cpuUser: float64(),
    cpuSystem: float64(),
});
const Ready = object({
    type: literal('ready'),
    port: uint16(),
});
const HeartbeatClient = object({
    clientId: string(),
    tags: record(string()),
});
const Heartbeat = object({
    type: literal('heartbeat'),
    timestamp: float64(),
    // optional: not every room runtime can report process metrics (e.g. a
    // workerd isolate has no process.memoryUsage)
    metrics: optional(ProcessMetrics),
    clients: list(HeartbeatClient),
});
const ClientConnected = object({
    type: literal('client-connected'),
    clientId: string(),
    roomId: string(),
    tags: record(string()),
});
const ClientDisconnected = object({
    type: literal('client-disconnected'),
    clientId: string(),
});
const ErrorMsg = object({
    type: literal('error'),
    message: string(),
});
const Stopped = object({
    type: literal('stopped'),
});
const NotifyMessageSchema = union('type', [Ready, Heartbeat, ClientConnected, ClientDisconnected, ErrorMsg, Stopped]);
const notifyCodec = build(NotifyMessageSchema);
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
    return encodeRawFrame(notifyCodec.pack(msg));
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
    if (typeof payload.exp === 'number' && Date.now() > payload.exp)
        return null;
    return payload;
}

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
//   0x00 = protocol message (packcat-encoded payload follows)
//   0x01 = user text message (raw utf-8 bytes follow)
//   0x02 = user binary message (raw bytes follow)
//
// protocol messages use packcat for the payload after the type byte.
// user messages pass through with minimal overhead (1 byte prefix).
// gatho wire protocol version. client and server versions must match exactly —
// the room rejects any connect whose `gv` query param is missing or different.
// bump this on any breaking change to the frame layout or protocol messages.
const PROTOCOL_VERSION = 1;
// frame type constants
const FRAME_PROTOCOL = 0x00;
const FRAME_USER_TEXT = 0x01;
const FRAME_USER_BINARY = 0x02;
// protocol message schemas
const Session = object({
    type: literal('session'),
    token: string(),
});
const AuthError = object({
    type: literal('auth_error'),
    error: string(),
});
const Leave = object({
    type: literal('leave'),
});
const ProtocolMessage = union('type', [Session, AuthError, Leave]);
const codec = build(ProtocolMessage);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
// pack a protocol message: [0x00, ...packcat bytes]
function packProtocol(msg) {
    const payload = codec.pack(msg);
    const frame = new Uint8Array(1 + payload.byteLength);
    frame[0] = FRAME_PROTOCOL;
    frame.set(payload, 1);
    return frame;
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
    const payload = view.subarray(1);
    switch (type) {
        case FRAME_PROTOCOL:
            return { frame: 'protocol', message: codec.unpack(payload) };
        case FRAME_USER_TEXT:
            return { frame: 'user_text', text: textDecoder.decode(payload) };
        case FRAME_USER_BINARY:
            // return a copy as ArrayBuffer so the caller owns the memory
            return {
                frame: 'user_binary',
                data: payload.slice().buffer,
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
                        .catch(() => {
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
                        };
                        if (reconnecting) {
                            handlers.reconnect(clientId, wsSocket, versionMismatch);
                        }
                        else {
                            handlers.open(clientId, wsSocket, joinData, tags, versionMismatch);
                        }
                        ws.on('message', (data, isBinary) => {
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
                            // clean up topic subscriptions
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
function createClient(tracked) {
    return { id: tracked.id, data: tracked.data };
}
function createClientCollection(clients) {
    return {
        get(id) {
            const c = clients.get(id);
            if (!c)
                return undefined;
            return createClient(c);
        },
        has(id) {
            return clients.has(id);
        },
        count() {
            return clients.size;
        },
        forEach(callback) {
            for (const [id, c] of clients) {
                callback(createClient(c), id);
            }
        },
        ids() {
            return Array.from(clients.keys());
        },
        all() {
            return Array.from(clients.values()).map((c) => createClient(c));
        },
    };
}
// default per-client reliable message buffer cap: 1mb
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576;
// permanently remove a client — cancel timers, invalidate session token,
// fire onLeave, notify driver. used on reconnect window expiry, buffer overflow,
// consented close, and disconnect without allowReconnection.
function evictClient(state, tracked, room, onLeave) {
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
    // fire onLeave
    if (onLeave) {
        safeCall(state.log, 'onLeave', () => onLeave(room, createClient(tracked)));
    }
    // notify driver
    state.ipc?.send({ type: 'client-disconnected', clientId: tracked.id });
}
function createRoom(state, maxBufferBytes, callbacks) {
    let room;
    // buffer a reliable message for a disconnected client.
    // if byte cap exceeded, evict the client.
    function bufferForClient(tracked, payload) {
        const byteSize = payload.byteLength;
        tracked.reliableBuffer.push({ payload, byteSize });
        tracked.reliableBufferBytes += byteSize;
        if (tracked.reliableBufferBytes > maxBufferBytes) {
            evictClient(state, tracked, room, callbacks.onLeave);
        }
    }
    room = {
        get roomId() {
            return state.roomId;
        },
        get roomType() {
            return state.roomType;
        },
        get serverId() {
            return state.serverId;
        },
        send(client, message, options) {
            if (!state.alive)
                return;
            const tracked = state.clients.get(client.id);
            if (!tracked)
                return;
            const framed = frameUserMessage(message);
            const reliable = options?.reliable !== false;
            if (tracked.socket) {
                tracked.socket.send(framed, true);
            }
            else if (reliable) {
                bufferForClient(tracked, framed);
            }
        },
        broadcast(message, options) {
            if (!state.alive)
                return;
            if (!state.server)
                return;
            const framed = frameUserMessage(message);
            const reliable = options?.reliable !== false;
            state.server.publish(BROADCAST_TOPIC, framed, true);
            if (reliable) {
                for (const tracked of state.clients.values()) {
                    if (!tracked.socket) {
                        bufferForClient(tracked, framed);
                    }
                }
            }
        },
        get clients() {
            return createClientCollection(state.clients);
        },
        allowReconnection(client, windowMs) {
            const tracked = state.clients.get(client.id);
            if (!tracked)
                return;
            // only meaningful when the client is disconnected
            if (tracked.socket)
                return;
            // set up the disconnect timer — when it fires, the client is evicted
            tracked.disconnectTimer = setTimeout(() => {
                tracked.disconnectTimer = null;
                evictClient(state, tracked, room, callbacks.onLeave);
            }, windowMs);
        },
        disconnect(client) {
            const tracked = state.clients.get(client.id);
            if (!tracked)
                return;
            // server-initiated consented close — skip onDrop, straight to eviction
            evictClient(state, tracked, room, callbacks.onLeave);
        },
        stop() {
            return stopRoom(state, true, room, callbacks.onShutdown, callbacks.onLeave);
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
        if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function' && typeof process.cpuUsage === 'function') {
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
// --- ws server ---
function startRoom(state, transport, options) {
    // the room handle is created once and shared — same object passed to callbacks
    // and returned from start()
    const room = createRoom(state, options.maxBufferBytes, {
        onLeave: options.onLeave,
        onShutdown: options.onShutdown,
    });
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
                socket.close(4000, 'protocol version mismatch');
                return;
            }
            socket.subscribe(BROADCAST_TOPIC);
            (async () => {
                let result;
                try {
                    result = await Promise.resolve(options.onAuth ? options.onAuth(room, joinData) : { ok: true, data: {} });
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
                // track client
                const tracked = {
                    id: clientId,
                    data: result.data,
                    socket,
                    sessionToken,
                    reliableBuffer: [],
                    reliableBufferBytes: 0,
                    disconnectTimer: null,
                    tags,
                };
                state.clients.set(clientId, tracked);
                // send session token to client
                socket.send(packProtocol({ type: 'session', token: sessionToken }), true);
                // notify server for driver bookkeeping (managed mode only).
                // forward roomId + tags so driver.connectClient can perform a
                // full upsert — covers the case where the driver's client
                // record was evicted between reserveClient and now.
                state.ipc?.send({ type: 'client-connected', clientId, roomId: state.roomId, tags });
                // run onJoin
                if (options.onJoin) {
                    await Promise.resolve(options.onJoin(room, createClient(tracked)));
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
                    safeCall(state.log, 'onMessage', () => options.onMessage(room, createClient(tracked), frame.text));
                }
                else {
                    safeCall(state.log, 'onMessage', () => options.onMessage(room, createClient(tracked), frame.data));
                }
            }
        },
        reconnect(clientId, socket, versionMismatch) {
            // reject a protocol-version-mismatched client with a readable error
            // before touching reconnection state.
            if (versionMismatch) {
                socket.send(packProtocol({ type: 'auth_error', error: versionMismatch }), true);
                socket.close(4000, 'protocol version mismatch');
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
            socket.send(packProtocol({ type: 'session', token: newToken }), true);
            // fire onReconnect
            if (options.onReconnect) {
                safeCall(state.log, 'onReconnect', () => options.onReconnect(room, createClient(tracked)));
            }
            // notify driver: client is connected again. forward roomId + the
            // tags we cached at original open() — same upsert path as fast.
            state.ipc?.send({ type: 'client-connected', clientId, roomId: state.roomId, tags: tracked.tags });
        },
        close(clientId, code) {
            const tracked = state.clients.get(clientId);
            if (!tracked)
                return;
            // consented close (4000) or no onDrop defined — permanent leave
            if (code === 4000 || !options.onDrop) {
                evictClient(state, tracked, room, options.onLeave);
                return;
            }
            // non-consented disconnect — mark as disconnected, fire onDrop
            tracked.socket = null;
            const onDrop = options.onDrop;
            (async () => {
                // fire onDrop — room code may call allowReconnection inside
                await Promise.resolve(onDrop(room, createClient(tracked), code));
                // if allowReconnection was NOT called (no timer set), evict immediately
                if (!tracked.disconnectTimer) {
                    // check the client is still in the map (not already evicted by something else)
                    if (state.clients.has(tracked.id)) {
                        evictClient(state, tracked, room, options.onLeave);
                    }
                }
            })().catch((err) => {
                state.log.error('onDrop threw unexpectedly', { clientId, err });
            });
        },
    };
    return transport.listen(handlers, { port: options.port }).then((server) => {
        state.server = server;
        return { port: server.port, room };
    });
}
async function stopRoom(state, selfInitiated, room, onShutdown, onLeave) {
    if (!state.alive)
        return;
    state.alive = false;
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
        // cancel any pending disconnect timer
        if (tracked.disconnectTimer) {
            clearTimeout(tracked.disconnectTimer);
            tracked.disconnectTimer = null;
        }
        // clear reliable buffer
        tracked.reliableBuffer.length = 0;
        tracked.reliableBufferBytes = 0;
        // fire onLeave
        if (onLeave && room) {
            safeCall(state.log, 'onLeave', () => onLeave(room, createClient(tracked)));
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
async function start(options) {
    // --- resolve managed context ---
    const presentEnvKeys = MANAGED_ENV_KEYS.filter((k) => readEnv(k) !== undefined);
    const hasServerOption = options.server !== undefined;
    let server;
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
        server = undefined;
        roomId = crypto.randomUUID();
        roomType = 'room';
        notifySource = undefined;
        roomSecret = null;
        serverId = undefined;
    }
    else {
        server = options.server;
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
            throw new Error('gatho/room start(): no managed server context detected ' +
                '(no GATHO_NOTIFY_SOCKET / GATHO_ROOM_SECRET env vars, and no options.server.notify / roomSecret). ' +
                'If running this room directly for local dev or tests, pass `standalone: true`. ' +
                'Otherwise ensure the gatho server spawned this process so GATHO_* env vars are set.');
        }
    }
    // set up the notify link (managed mode). a Notifier object is used as-is
    // (in-process hosting); a uri string is dialed over uds/tcp — node:net is
    // loaded lazily inside the dialer, so non-node bundles that always pass a
    // Notifier object never execute a node import.
    let ipc = null;
    if (typeof notifySource === 'string') {
        ipc = await connectNotify(parseNotifyTarget(notifySource));
    }
    else if (notifySource) {
        ipc = notifySource;
    }
    const log = createLogger().child({ roomId, roomType });
    const state = {
        roomId,
        roomType,
        serverId,
        roomSecret,
        clients: new Map(),
        sessionTokens: new Map(),
        ipc,
        heartbeatInterval: null,
        alive: true,
        server: null,
        sigtermHandler: null,
        log,
    };
    const transport = options.transport ?? wsTransport();
    const { port, room } = await startRoom(state, transport, {
        port: options.port,
        maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
        onAuth: options.onAuth,
        onJoin: options.onJoin,
        onMessage: options.onMessage,
        onLeave: options.onLeave,
        onDrop: options.onDrop,
        onReconnect: options.onReconnect,
        onShutdown: options.onShutdown,
    });
    if (ipc) {
        startHeartbeat(state);
        ipc.send({ type: 'ready', port });
    }
    // signal handling belongs to whoever owns the process — install only where
    // there is one (node/bun/deno; workerd isolates have no signals).
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
        const sigtermHandler = () => {
            stopRoom(state, false, room, options.onShutdown, options.onLeave).catch((err) => {
                state.log.error('error during shutdown', { err });
            });
        };
        state.sigtermHandler = sigtermHandler;
        process.on('SIGTERM', sigtermHandler);
    }
    return room;
}

// gatho/room — room-side api
// rooms are scripts. user initializes state in module scope, calls start()
// which returns a Room handle. no defineRoom, no hook bags, no RoomContext.
// the module IS the room: state closes over module scope, and instancing
// happens by evaluating the module in a fresh process / worker / isolate.
// protocol helpers for non-node runtimes that need to speak the notify wire
// protocol themselves (e.g. a workerd harness relaying room notifications over tcp)
// --- close codes ---
// websocket close codes that gatho uses to distinguish disconnect reasons.
// 4000 (CONSENTED) = the client explicitly called close() — sent __leave first.
// everything else fires onDrop, giving the room code a chance to call allowReconnection.
const CloseCode = {
    NORMAL: 1000,
    GOING_AWAY: 1001,
    ABNORMAL: 1006,
    CONSENTED: 4000,
};
// helpers for returning auth results with correct literal types
// avoids the user needing `as const` on every return
const auth = {
    ok(data = {}) {
        return { ok: true, data };
    },
    fail(error) {
        return { ok: false, error };
    },
};

export { CloseCode, auth, createFrameParser, encodeNotifyFrame, encodeRawFrame, notifyCodec, start, wsTransport };
//# sourceMappingURL=room.js.map
