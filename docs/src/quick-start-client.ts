// client.ts
import { connect } from 'gatho/client';

const url = new URLSearchParams(window.location.search).get('url')!;
const room = connect(url);

room.on('message', (msg) => {
    const { count } = msg as { count: number };
    console.log('count:', count);
});

room.send({ type: 'increment' });
