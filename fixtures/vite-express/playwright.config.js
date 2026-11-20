import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  use: { baseURL: 'http://localhost:3100' },
  webServer: {
    command: 'npm run build && npm start',
    url: 'http://localhost:3100/__version',
    env: { PORT: '3100', TEST_HOOKS: '1' },
    reuseExistingServer: false,
  },
});
