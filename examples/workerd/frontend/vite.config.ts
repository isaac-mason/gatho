import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [react()],
    server: {
        // uncommon port to avoid the usual 5173/3000 conflicts (website uses 7173).
        port: 7373,
        // forward the join api to the backend so the frontend can use relative
        // /api paths.
        proxy: {
            '/api': 'http://localhost:7300',
        },
    },
});
