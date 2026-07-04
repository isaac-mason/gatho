// Ambient declarations for the workerd runtime modules/globals the harness and
// adapter use. These code paths run inside workerd (not node), so we declare just
// enough surface to typecheck the example without pulling @cloudflare/workers-types.

declare module 'cloudflare:workers' {
    export class WorkerEntrypoint<Env = unknown> {
        protected readonly ctx: {
            waitUntil(p: Promise<unknown>): void;
            exports: Record<string, (opts: { props?: Record<string, unknown> }) => unknown>;
            props?: Record<string, unknown>;
        };
        protected readonly env: Env;
        constructor(ctx: unknown, env: Env);
    }
}

declare module 'cloudflare:sockets' {
    export function connect(
        address: string | { hostname: string; port: number },
    ): {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
        close(): void;
    };
}

declare module 'workerd' {
    const workerd: { default: string; compatibilityDate: string; version: string };
    export default workerd;
}
