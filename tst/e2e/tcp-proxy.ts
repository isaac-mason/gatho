import { type AddressInfo, connect, createServer, type Socket } from 'node:net';

export type ProxiedConnection = {
    /** closes the upstream side while the client's side stays open and silent: a RST that reached only the server */
    dropUpstreamSilently(): void;
    /** stops both directions while both sockets stay open: a black-holed path */
    blackhole(): void;
};

export type TcpProxy = {
    port: number;
    /** proxied connections in the order clients opened them */
    connections: ProxiedConnection[];
    close(): Promise<void>;
};

export async function startTcpProxy(targetHost: string, targetPort: number): Promise<TcpProxy> {
    const sockets = new Set<Socket>();
    const connections: ProxiedConnection[] = [];

    const server = createServer((downstream) => {
        const upstream = connect(targetPort, targetHost);
        sockets.add(downstream);
        sockets.add(upstream);
        let forwarding = true;

        downstream.on('data', (chunk) => {
            if (forwarding) upstream.write(chunk);
        });
        upstream.on('data', (chunk) => {
            if (forwarding) downstream.write(chunk);
        });
        // while healthy, a close on either side is a close on both
        downstream.on('close', () => {
            if (forwarding) upstream.destroy();
        });
        upstream.on('close', () => {
            if (forwarding) downstream.destroy();
        });
        downstream.on('error', () => upstream.destroy());
        upstream.on('error', () => {
            if (forwarding) downstream.destroy();
        });

        connections.push({
            dropUpstreamSilently() {
                forwarding = false;
                upstream.destroy();
            },
            blackhole() {
                forwarding = false;
            },
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        port: (server.address() as AddressInfo).port,
        connections,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
