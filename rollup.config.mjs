import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const baseDir = import.meta.dirname;

const kb = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;

// prints each emitted bundle's raw and gzipped size
function sizes() {
    return {
        name: 'sizes',
        writeBundle(options, outputBundle) {
            for (const chunk of Object.values(outputBundle)) {
                if (chunk.type !== 'chunk') continue;
                const code = Buffer.from(chunk.code);
                const file = path.join(options.dir ?? path.dirname(options.file), chunk.fileName);
                console.log(`${file}: ${kb(code.length)}, gzipped ${kb(gzipSync(code).length)}`);
            }
        },
    };
}

function bundle(input, output, external = []) {
    return {
        input,
        external,
        output: [
            {
                file: output,
                format: 'es',
                sourcemap: true,
                exports: 'named',
            },
        ],
        plugins: [
            nodeResolve(),
            typescript({
                tsconfig: path.resolve(baseDir, './tsconfig.json'),
                compilerOptions: {
                    noEmit: false,
                    declaration: true,
                    declarationDir: path.resolve(baseDir, 'dist'),
                    rootDir: path.resolve(baseDir, 'src'),
                },
            }),
            sizes(),
        ],
    };
}

export default [
    bundle('./src/server/index.ts', 'dist/server.js'),
    bundle('./src/client/index.ts', 'dist/client.js'),
    bundle('./src/room/index.ts', 'dist/room.js', ['ws']),
    bundle('./src/sdk/index.ts', 'dist/sdk.js', ['gatho/driver']),
    // memory driver + types + errors — no ioredis import in this graph, so
    // memory-only / bundled installs pull `gatho/driver` without ioredis present.
    bundle('./src/driver/index.ts', 'dist/driver.js'),
    // redis driver lives on its own subpath (`gatho/driver/redis`). ioredis is an
    // optional peer dep (external); the error classes come from `gatho/driver`
    // (external) so they keep one identity across the split.
    bundle('./src/driver/redis.ts', 'dist/driver-redis.js', ['ioredis', 'gatho/driver']),
];
