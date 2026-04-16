import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tst/browser',
    timeout: 30_000,
    retries: 0,
    use: {
        browserName: 'chromium',
        headless: true,
    },
});
