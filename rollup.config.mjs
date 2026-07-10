import path from 'node:path';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import filesize from 'rollup-plugin-filesize';

const baseDir = import.meta.dirname;

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
            filesize(),
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
