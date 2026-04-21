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
    bundle('./src/driver/index.ts', 'dist/driver.js', ['postgres', 'ioredis']),
];
