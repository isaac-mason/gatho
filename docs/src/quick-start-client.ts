// client.ts
import { connect } from 'gatho/client';

const url = new URLSearchParams(window.location.search).get('url')!;

const room = connect(url, {
    onMessage: (msg) => {
        if (typeof msg !== 'string') return;
        const { count } = JSON.parse(msg) as { count: number };
        console.log('count:', count);
    },
});

room.send(JSON.stringify({ type: 'increment' }));
